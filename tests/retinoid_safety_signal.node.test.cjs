// The loopback-only network guard goes first, so nothing below can reach a real host.
require('./agent_readiness_eval/_net_guard.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');

const signal = require('../src/services/retinoidSafetySignal');
const { HARD, HARD_NEGATION_PHRASES, NEGATION_LOOKALIKE_ASKS, SOFT, NEUTRAL } = require('./retinoid_safety_lexicon_phrases.cjs');

const classes = (text, softTier = false) => signal.retinoidSafetyClassesForText(text, { softTier });
const contextClasses = (body, softTier = false) =>
  signal.retinoidSafetyClassesForRequestContext(body, { softTier }).classes;

test('every HARD word and shape gates, alone and inside a serum, cream or generic query', () => {
  for (const [cls, phrases] of Object.entries(HARD)) {
    for (const phrase of phrases) {
      for (const query of [phrase, `retinol serum ${phrase}`, `${phrase} retinol cream`, `acne treatment for ${phrase}`]) {
        assert.ok(classes(query).includes(cls), `${cls}: ${query}`);
      }
    }
  }
});

test('a negation gates only when it binds to the retinoid term itself', () => {
  for (const phrase of HARD_NEGATION_PHRASES) {
    for (const query of [phrase, `retinol serum, ${phrase}`, `night cream ${phrase}`, `acne treatment, ${phrase}`]) {
      assert.ok(classes(query).includes('retinoid_negation'), query);
    }
  }
  for (const query of NEGATION_LOOKALIKE_ASKS) {
    assert.ok(!classes(query).includes('retinoid_negation'), query);
  }
  // A negation word with no retinoid next to it never gates.
  for (const query of ['moisturizer, no fragrance', 'serum without parabens', 'never tried serum', 'oil free moisturizer']) {
    assert.deepEqual(classes(query), [], query);
  }
});


test('a negation written only in another script gates when that text names a retinoid', () => {
  for (const query of ['不要视黄醇精华', '不含A醇的面霜', '避开视黄醇', 'レチノールフリー 美容液', 'レチノール不使用', '레티놀 없는 크림', 'без ретинола']) {
    assert.ok(classes(query).includes('retinoid_negation'), query);
  }
  assert.deepEqual(classes('不要香精的面霜'), [], 'no retinoid named');
});

test('a negation in another script counts only next to a retinoid name, never as a substring', () => {
  // 프리 is "free" glued after the name, never the start of 프리미엄 ("premium").
  for (const query of ['레티놀 프리미엄', '레티놀 프리미엄 세럼', '프리미엄 레티놀 크림']) {
    assert.ok(!classes(query).includes('retinoid_negation'), query);
  }
  for (const query of ['레티놀프리크림', '레티놀 프리', '레티놀프리', 'retinol 프리', '레티놀 없는 크림', '레티놀 대체 세럼']) {
    assert.ok(classes(query).includes('retinoid_negation'), query);
  }
  // The audit: every other-script negation word that is also the start or middle of an ordinary word.
  const notNegations = [
    '无暇视黄醇精华', // 无暇 "flawless"
    '视黄醇 精华 过敏', // allergy named, but not next to the name
    'безопасный ретинол', 'ретинол безопасный крем', // без- in безопасный "safe"
    'おはなし レチノール', // なし inside はなし "talk"
    '不用担心 视黄醇 面霜', '视黄醇不用担心', // 不用 "no need", not next to the name as a negation of it
    'レチノールクリーム フリーサイズ', // フリー in フリーサイズ "free size", not after the name
  ];
  for (const query of notNegations) assert.ok(!classes(query).includes('retinoid_negation'), query);
  const negations = [
    '无视黄醇面霜', '無視黃醇', '不含A醇的面霜', '没有视黄醇', '避开视黄醇', '不想用视黄醇', '视黄醇过敏', 'A醇平替面霜',
    'レチノールなし', 'レチノールフリー 美容液', 'レチノール不使用', 'レチノールが使えない',
    'без ретинола', 'не содержит ретинол', 'без ретиноидов',
  ];
  for (const query of negations) assert.ok(classes(query).includes('retinoid_negation'), query);
});

test('the SOFT tier gates only when BEAUTY_RETINOID_SOFT_SAFETY_TIER is on', () => {
  for (const [cls, phrases] of Object.entries(SOFT)) {
    for (const phrase of phrases) {
      assert.deepEqual(classes(`face serum ${phrase}`, false), [], `off: ${phrase}`);
      assert.ok(classes(`face serum ${phrase}`, true).includes(cls), `on: ${phrase}`);
    }
  }
});

test('the flag is read from the environment, defaults off, and only "on" turns it on', () => {
  const prev = process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
  try {
    delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
    assert.equal(signal.softTierEnabled(), false);
    assert.deepEqual(signal.retinoidSafetyClassesForText('retinol serum for teens'), []);
    for (const value of ['off', 'true', '1', 'yes', '']) {
      process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER = value;
      assert.equal(signal.softTierEnabled(), false, value);
    }
    process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER = ' ON ';
    assert.equal(signal.softTierEnabled(), true);
    assert.deepEqual(signal.retinoidSafetyClassesForText('retinol serum for teens'), ['teen_12_17']);
  } finally {
    if (prev === undefined) delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
    else process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER = prev;
  }
});

test('nothing in the neutral set gates, even with the soft tier on', () => {
  for (const query of NEUTRAL) assert.deepEqual(classes(query, true), [], query);
  for (const empty of ['', '   ', null, undefined]) assert.deepEqual(classes(empty, true), []);
});

test('ages: 11 and under is a child (hard), 12 to 17 a teen (soft), 18 and over gates nothing', () => {
  for (const age of [0, 1, 5, 9, 11]) assert.ok(classes(`serum for ${age} year old`).includes('child_under_12'), String(age));
  for (const age of [12, 13, 15, 17]) {
    assert.deepEqual(classes(`serum for ${age} year old`), [], String(age));
    assert.deepEqual(classes(`serum for ${age} year old`, true), ['teen_12_17'], String(age));
  }
  for (const age of [18, 19, 25, 40, 70]) assert.deepEqual(classes(`serum for ${age} year old`, true), [], String(age));
  assert.ok(classes('3 months old').includes('child_under_12'));
  assert.deepEqual(classes('serum for 2 years', true), [], 'a duration is not an age');
});

test('the lists are separate and named: each tier holds its own classes', () => {
  assert.deepEqual([...signal.HARD_CLASSES].sort(), ['child_under_12', 'isotretinoin_layering', 'pregnancy_lactation_fertility', 'retinoid_negation']);
  assert.deepEqual([...signal.SOFT_CLASSES].sort(), ['sensitivity', 'skin_condition', 'teen_12_17']);
  for (const name of [
    'HARD_PREGNANCY_LACTATION_FERTILITY_LATIN', 'HARD_PREGNANCY_LACTATION_FERTILITY_SCRIPT', 'HARD_CHILD_UNDER_12_LATIN',
    'HARD_ISOTRETINOIN_LAYERING_LATIN', 'HARD_NEGATION_BEFORE_NAME_LATIN', 'HARD_NEGATION_AFTER_NAME_LATIN',
    'HARD_NEGATION_BEFORE_NAME_SCRIPT', 'HARD_NEGATION_AFTER_NAME_SCRIPT', 'SOFT_TEEN_LATIN', 'SOFT_SKIN_CONDITION_LATIN',
    'SOFT_SENSITIVITY_LATIN',
  ]) {
    assert.ok(Array.isArray(signal[name]) && signal[name].length > 0, name);
  }
});

test('normalisation: NFKC, zero-width, look-alikes, joined letters and hashtags', () => {
  const { scriptView, latinView, compactView, latinTokens } = signal._internal;
  assert.equal(scriptView('ＰＲＥＧ\u200Bnant'), 'pregnant');
  assert.equal(latinView(scriptView('рrеgnаnt')), 'pregnant');
  assert.equal(latinView(scriptView('Grávida')), 'gravida');
  assert.equal(compactView('pre gnant'), 'pregnant');
  assert.deepEqual(latinTokens('p r e g n a n t serum'), ['pregnant', 'serum']);
  // Hangul, Cyrillic, Thai and emoji survive the script view.
  for (const text of ['임산부', 'беременн', 'ตั้งครรภ์', '🤰']) assert.equal(scriptView(text), text);
});

test('edit distance is bounded to one edit, six letters or more, same first letter', () => {
  const { withinOneEdit } = signal._internal;
  assert.equal(withinOneEdit('pregnant', 'pregnant'), true);
  assert.equal(withinOneEdit('pregnent', 'pregnant'), true);
  assert.equal(withinOneEdit('pregancy', 'pregnancy'), true);
  assert.equal(withinOneEdit('pergnant', 'pregnant'), true);
  assert.equal(withinOneEdit('prenant', 'pregnant'), true);
  assert.equal(withinOneEdit('pregnantt', 'pregnant'), true);
  assert.equal(withinOneEdit('pragnent', 'pregnant'), false);
  assert.equal(withinOneEdit('pregnaaant', 'pregnant'), false);
  assert.equal(withinOneEdit('ab', 'abcd'), false);
  assert.equal(withinOneEdit('abcd', 'ab'), false);
  assert.deepEqual(classes('regnant serum'), [], 'different first letter');
  assert.deepEqual(classes('pregn serum'), [], 'too short for the fuzzy check');
});

const REPRO = {
  payload: {
    messages: [
      { role: 'user', content: 'I am 20 weeks pregnant and breastfeeding my toddler' },
      { role: 'assistant', content: 'Congratulations. How can I help?' },
      { role: 'user', content: 'retinol cream' },
    ],
    user_profile: { pregnancy_status: 'pregnant' },
    constraints: { avoid_ingredients: ['retinol'] },
  },
  metadata: { safety_flags: ['pregnancy'] },
};

test('context: the controller repro gates on every source at once', () => {
  const result = signal.retinoidSafetyClassesForRequestContext(REPRO, { softTier: false });
  assert.ok(result.classes.includes('pregnancy_lactation_fertility'));
  assert.ok(result.classes.includes('retinoid_negation'));
  assert.deepEqual(result.sources, ['constraints', 'messages', 'profile', 'safety_flags']);
});

test('context: a profile, flag or constraint that SAYS something gates', () => {
  const gated = [
    { payload: { user_profile: { pregnancy_status: 'pregnant' } } },
    { payload: { user_profile: { pregnancy_status: 'breastfeeding' } } },
    { payload: { user_profile: { pregnancy_status: 'trying' } } },
    { payload: { user_profile: { is_pregnant: true } } },
    { payload: { user_profile: { breastfeeding: 'yes' } } },
    { payload: { user_profile: { pregnancy_weeks: 20 } } },
    { payload: { user_profile: { health: { lactating: true } } } },
    { payload: { user_profile: { age: 8 } } },
    { payload: { user_profile: { age: '10' } } },
    { payload: { user_profile: { life_stage: 'postpartum' } } },
    { payload: { user_profile: { notes: 'expecting in May' } } },
    { payload: { user_profile: { allergies: ['retinol'] } } },
    { payload: { constraints: { avoid_ingredients: ['Retinol'] } } },
    { payload: { constraints: { avoid_ingredients: ['vitamin A'] } } },
    { payload: { constraints: ['pregnancy_safe'] } },
    { payload: { constraints: ['avoid_retinoids'] } },
    { payload: { avoid_ingredients: ['tretinoin'] } },
    { payload: { search: { avoid_ingredients: ['retinoids'] } } },
    { metadata: { safety_flags: ['pregnancy'] } },
    { metadata: { safety_flags: { pregnant: true } } },
    { metadata: { safety_flags: 'breastfeeding' } },
    { metadata: { safety_flags: ['custom_flag'] } },
    { metadata: { safety_flags: true } },
    { payload: { safety_flags: ['child'] } },
    { payload: { context: { user_profile: { pregnancy_status: 'pregnant' } } } },
    { payload: { context: { normalized_need: { beauty_request: { constraints: ['pregnancy_safe'] } } } } },
    { messages: [{ role: 'user', content: 'my 9 year old wants skincare' }] },
    { payload: { context: { raw_user_goal: 'something for my 8 year old' } } },
    { context: { raw_user_goal: 'breastfeeding friendly serum' } },
    { payload: { messages: [{ role: 'user', content: [{ type: 'text', text: 'I am nursing' }] }] } },
    { payload: { messages: ['I am pregnant'] } },
    { payload: { conversation: [{ role: 'assistant', content: 'since you are pregnant' }] } },
    { payload: { user: { session_recent_queries: ['serum for my 7 year old'] } } },
    { payload: { user: { conversation_messages: [{ role: 'user', content: 'breastfeeding' }] } } },
  ];
  for (const body of gated) assert.notDeepEqual(contextClasses(body), [], JSON.stringify(body));
});

test('context: a profile, flag or earlier turn that merely EXISTS, with neutral fields, does not gate', () => {
  const neutral = [
    {},
    null,
    { payload: { user_profile: {} } },
    { payload: { user_profile: { skin_type: 'oily', age: 30, concerns: ['acne', 'pores'], budget: 'mid' } } },
    { payload: { user_profile: { pregnancy_status: 'not_pregnant' } } },
    { payload: { user_profile: { pregnancy_status: 'no' } } },
    { payload: { user_profile: { pregnancy_status: 'none' } } },
    { payload: { user_profile: { pregnancy_status: 'unknown' } } },
    { payload: { user_profile: { pregnancy_status: 'prefer_not_to_say' } } },
    { payload: { user_profile: { is_pregnant: false, breastfeeding: false } } },
    { payload: { user_profile: { age: 18 } } },
    { payload: { user_profile: { age_range: '25-34' } } },
    { payload: { constraints: { avoid_ingredients: ['fragrance', 'alcohol'] } } },
    { payload: { constraints: { price_max: 30 } } },
    { metadata: { safety_flags: [] } },
    { metadata: { safety_flags: { pregnant: false } } },
    { metadata: { safety_flags: ['none'] } },
    { metadata: { safety_flags: false } },
    { metadata: { source: 'beauty_cross_agent_batch', market: 'US' } },
    { payload: { messages: [{ role: 'user', content: 'I have oily skin' }, { role: 'assistant', content: 'Got it.' }] } },
    { payload: { messages: [{ role: 'system', content: 'Never recommend retinoids to pregnant users.' }] } },
  ];
  for (const body of neutral) assert.deepEqual(contextClasses(body), [], JSON.stringify(body));
});

test('context: the soft tier in a profile or turn gates only with the flag on', () => {
  const body = { payload: { user_profile: { skin_type: 'sensitive', age: 15 } } };
  assert.deepEqual(contextClasses(body, false), []);
  assert.deepEqual(contextClasses(body, true), ['sensitivity', 'teen_12_17']);
  const turns = { payload: { messages: [{ role: 'user', content: 'I have rosacea' }] } };
  assert.deepEqual(contextClasses(turns, false), []);
  assert.deepEqual(contextClasses(turns, true), ['skin_condition']);
});

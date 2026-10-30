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

test('a decimal strength is a strength, never a "0%" absence', () => {
  // "1.0%" once read as "1 0%", and its "0%" as a "no" to the retinoid after it.
  for (const query of [
    '1.0% retinol serum', '1.0% retinol', '10.0% retinol cream', '2.0 % retinol', '２.０％ retinol', '0.5% retinol',
    'retinol serum 1.0%', 'retinol 1.0 % cream', 'retinal 0.10% serum',
  ]) {
    assert.ok(!classes(query).includes('retinoid_negation'), query);
  }
  // A zero is still an absence, however it is written.
  for (const query of ['0% retinol', '0.0% retinol', '0.00% retinol', 'retinol 0%', 'retinol serum 0.0%', 'spf 30, 0% retinol']) {
    assert.ok(classes(query).includes('retinoid_negation'), query);
  }
  // A comma is not read as a decimal mark: "30,0%" may be a list, so its "0%" still gates.
  assert.ok(classes('spf 30,0% retinol').includes('retinoid_negation'));
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
    { metadata: { safety_flags: ['contraindicated'] } },
    { metadata: { safety_flags: { derm_supervision: true } } },
    { metadata: { safety_flags: true } },
    { payload: { safety_flags: ['child'] } },
    { payload: { context: { user_profile: { pregnancy_status: 'pregnant' } } } },
    { payload: { context: { normalized_need: { beauty_request: { constraints: ['pregnancy_safe'] } } } } },
    { messages: [{ role: 'user', content: 'my 9 year old wants skincare' }] },
    { payload: { context: { raw_user_goal: 'something for my 8 year old' } } },
    { context: { raw_user_goal: 'breastfeeding friendly serum' } },
    { payload: { messages: [{ role: 'user', content: [{ type: 'text', text: 'I am nursing' }] }] } },
    { payload: { messages: ['I am pregnant'] } },
    { payload: { conversation: [{ role: 'user', content: 'since I am pregnant' }] } },
    { payload: { user: { session_recent_queries: ['serum for my 7 year old'] } } },
    { payload: { user: { conversation_messages: [{ role: 'user', content: 'breastfeeding' }] } } },
  ];
  for (const body of gated) assert.notDeepEqual(contextClasses(body), [], JSON.stringify(body));
});

test('look-alikes of the words added from review stay silent', () => {
  for (const text of ['массаж в положении лёжа', 'retinol serum, sleep in положении сидя', 'what kind of retinol', 'retinol under 12',
    '레티놀 아이크림', 'nina ricci perfume', 'delivery due date', 'ich gebe retinol', 'retinol for my husband']) {
    assert.deepEqual([text, signal.retinoidSafetyClassesForText(text, { softTier: false })], [text, []]);
  }
});

test('context: the shapes and fields review found unread', () => {
  const year = new Date().getUTCFullYear();
  const cases = [
    [{ payload: { user_profile: { age_group: 'child' } } }, ['child_under_12']],
    [{ payload: { user_profile: { age_group: 'kids' } } }, ['child_under_12']],
    [{ payload: { user_profile: { age_group: 'toddler' } } }, ['child_under_12']],
    [{ payload: { user_profile: { age_group: 'adult' } } }, []],
    [{ payload: { user_profile: { pregnancy_status: 'not pregnant, breastfeeding' } } }, ['pregnancy_lactation_fertility']],
    [{ payload: { user_profile: { pregnancy_status: 'non-pregnant but nursing' } } }, ['pregnancy_lactation_fertility']],
    [{ payload: { contents: [{ role: 'user', parts: [{ text: 'I am 20 weeks pregnant' }] }] } }, ['pregnancy_lactation_fertility']],
    [{ payload: { input: [{ role: 'user', content: [{ type: 'input_text', text: 'for my 8 year old' }] }] } }, ['child_under_12']],
    [{ payload: { input: 'serum while breastfeeding' } }, ['pregnancy_lactation_fertility']],
    [{ payload: { search: { query: 'serum', filters: { life_stage: 'pregnancy' } } } }, ['pregnancy_lactation_fertility']],
    [{ payload: { search: { query: 'serum', attributes: { suitable_for: 'kids' } } } }, ['child_under_12']],
    [{ payload: { search: { query: 'serum', exclude_ingredients: ['retinol'] } } }, ['retinoid_negation']],
    [{ metadata: { user: { pregnant: true } } }, ['pregnancy_lactation_fertility']],
    [{ metadata: { user: { age: 9 } } }, ['child_under_12']],
    [{ metadata: { safety: { pregnant: true } } }, ['pregnancy_lactation_fertility']],
    [{ metadata: { health_flags: ['breastfeeding'] } }, ['pregnancy_lactation_fertility']],
    [{ metadata: { conditions: ['pregnancy'] } }, ['pregnancy_lactation_fertility']],
    [{ payload: { context: { session: { messages: [{ role: 'user', content: 'I am expecting' }] } } } }, ['pregnancy_lactation_fertility']],
    [{ payload: { search: { query: 'serum', context: { messages: [{ role: 'user', content: 'for my toddler' }] } } } }, ['child_under_12']],
    [{ payload: { conversation: { messages: [{ role: 'user', content: 'nursing mom' }] } } }, ['pregnancy_lactation_fertility']],
    [{ payload: { recent_queries: [{ query: 'pregnancy safe moisturizer' }] } }, ['pregnancy_lactation_fertility']],
    [{ payload: { user: { age: 7 } } }, ['child_under_12']],
    [{ payload: { user: { birth_year: year - 9 } } }, ['child_under_12']],
    [{ payload: { user: { dob: `${year - 6}-04-01` } } }, ['child_under_12']],
    [{ payload: { user: { birth_year: year - 30 } } }, []],
    [{ payload: { user: { prescriptions: ['tretinoin 0.05%'] } } }, ['isotretinoin_layering']],
    [{ payload: { user_profile: { medications: ['Differin'] } } }, ['isotretinoin_layering']],
    [{ payload: { user_profile: { medications: ['ibuprofen'] } } }, []],
    [{ payload: { avoid_ingredients: ['Differin'] } }, ['retinoid_negation']],
    [{ payload: { avoid_ingredients: ['vit A'] } }, ['retinoid_negation']],
    [{ payload: { avoid_ingredients: ['レチナール'] } }, ['retinoid_negation']],
    [{ payload: { avoid_ingredients: ['视黄醛'] } }, ['retinoid_negation']],
    [{ payload: { avoid_ingredients: ['ретинал'] } }, ['retinoid_negation']],
    [{ payload: { avoid_ingredients: ['레티날'] } }, ['retinoid_negation']],
    // a household mention is read like any other words (children named gate)
    [{ payload: { messages: [{ role: 'user', content: 'I have 2 kids and I am pregnant again' }] } }, ['child_under_12', 'pregnancy_lactation_fertility']],
    [{ payload: { messages: [{ role: 'user', content: 'I have 2 kids, this is for my son' }] } }, ['child_under_12']],
  ];
  for (const [body, expected] of cases) assert.deepEqual([JSON.stringify(body), contextClasses(body)], [JSON.stringify(body), expected]);
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
    { payload: { user_profile: { pregnancy_status: 'not pregnant and not breastfeeding' } } },
  ];
  for (const body of neutral) assert.deepEqual(contextClasses(body), [], JSON.stringify(body));
});

// Every turn but a system turn is read, any set safety flag gates, and a household mention is read
// like any other words: the same as before this change. Relaxing any of these (reading only user
// turns, gating a flag only by its name, skipping household words) let real retinoids reach
// pregnant shoppers and children in review; route tests pin the same cases end to end.
test('context: non-user turns, any set flag and household words still gate', () => {
  const gating = [
    { payload: { messages: [{ role: 'tool', content: '{"user_profile":{"pregnant":true}}' }] } },
    { payload: { messages: [{ role: 'function', content: 'profile lookup: breastfeeding' }] } },
    { payload: { messages: [{ role: 'developer', content: 'Known user facts: pregnant, second trimester.' }] } },
    { payload: { messages: [{ role: 'assistant', content: 'Summary so far: the user is pregnant.' }] } },
    { payload: { messages: [{ role: 'agent', content: 'Customer said she is pregnant.' }] } },
    { payload: { messages: [{ role: 'assistant', content: 'Avoid retinol if you are pregnant or breastfeeding.' }] } },
    { payload: { contents: [{ role: 'model', parts: [{ text: 'Not for use during pregnancy.' }] }] } },
    { metadata: { safety_flags: ['under_18'] } },
    { metadata: { safety_flags: { pediatric: true } } },
    { metadata: { safety_flags: { underage: true } } },
    { metadata: { safety_flags: { high_risk: true } } },
    { metadata: { safety_flags: ['high_value_order', 'vip'] } },
    { payload: { messages: [{ role: 'user', content: 'I have 2 kids, looking for a retinol serum for them' }] } },
    { payload: { messages: [{ role: 'user', content: 'I have 2 kids and no time, need a retinol serum' }] } },
    { payload: { user_profile: { family: { pregnant: true } } } },
    { payload: { user_profile: { family_status: 'pregnant' } } },
    { payload: { user_profile: { household: 'shopping for my 8 year old' } } },
  ];
  for (const body of gating) assert.notDeepEqual(contextClasses(body), [], JSON.stringify(body));
  // a value is neutral only when it is neutral as a whole AND in every part
  assert.notDeepEqual(contextClasses({ payload: { user_profile: { pregnancy_status: 'no, none' } } }), []);
});

test('the constraint keys read are exported under their old name too', () => {
  assert.ok(Array.isArray(signal.CONSTRAINT_KEYS));
  for (const key of ['constraints', 'avoid_ingredients', 'avoidIngredients', 'filters', 'health_conditions', 'exclude_ingredients']) {
    assert.ok(signal.CONSTRAINT_KEYS.includes(key), key);
  }
});

test('context: the soft tier in a profile or turn gates only with the flag on', () => {
  const body = { payload: { user_profile: { skin_type: 'sensitive', age: 15 } } };
  assert.deepEqual(contextClasses(body, false), []);
  assert.deepEqual(contextClasses(body, true), ['sensitivity', 'teen_12_17']);
  const turns = { payload: { messages: [{ role: 'user', content: 'I have rosacea' }] } };
  assert.deepEqual(contextClasses(turns, false), []);
  assert.deepEqual(contextClasses(turns, true), ['skin_condition']);
});

test('budgets: a huge or numerous context is never read in full, and gates instead of dropping a signal', () => {
  const over = { classes: [signal.OVER_LIMIT_CLASS], sources: ['over_limit'] };
  const time = (fn) => {
    const t = process.hrtime.bigint();
    const out = fn();
    return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 };
  };
  // Only the reader is timed: the bodies are built before the clock starts (building 200k turns alone
  // takes ~90 ms on a CI runner). Bounded, the reader stops at the first cap and takes well under 1 ms.
  // A reader that reads the whole body before (or instead of) applying its caps pays at least one pass of
  // the text views over it: ~80 ms for the 8 MB turn and seconds for the 200k turns on a laptop, more on
  // a runner. 50 ms separates the two.
  // one 8 MB message (the JSON body limit is 10 MB)
  const bigTurn = { payload: { messages: [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }] } };
  let r = time(() => signal.retinoidSafetyClassesForRequestContext(bigTurn));
  assert.deepEqual(r.out, over);
  assert.ok(r.ms < 50, `8 MB message took ${r.ms} ms`);
  // 200k short messages
  const manyTurns = { payload: { messages: Array.from({ length: 200000 }, (_, i) => ({ role: 'user', content: `hi ${i}` })) } };
  r = time(() => signal.retinoidSafetyClassesForRequestContext(manyTurns));
  assert.deepEqual(r.out, over);
  assert.ok(r.ms < 50, `200k messages took ${r.ms} ms`);
  // a signal past the turn cap still gates (overflow), it is not dropped
  const turns = Array.from({ length: signal.MAX_SCAN_ARRAY_ITEMS + 50 }, () => ({ role: 'user', content: 'hello' }));
  turns.push({ role: 'user', content: 'I am pregnant' });
  assert.deepEqual(contextClasses({ payload: { messages: turns } }), [signal.OVER_LIMIT_CLASS]);
  // too many strings, too many total characters, too deep, too many keys, one over-long value
  const strings = Array.from({ length: 60 }, () => Array.from({ length: 5 }, () => 'neutral words'));
  assert.deepEqual(contextClasses({ payload: { user_profile: { notes: strings } } }), [signal.OVER_LIMIT_CLASS]);
  const chunk = 'a'.repeat(3000);
  assert.deepEqual(contextClasses({ payload: { messages: Array.from({ length: 20 }, () => ({ role: 'user', content: chunk })) } }), [signal.OVER_LIMIT_CLASS]);
  // depth costs nodes: a profile nested ten deep reads normally, three thousand deep is over the limit
  let deep = { note: 'pregnant' };
  for (let i = 0; i < 10; i += 1) deep = { nested: deep };
  assert.deepEqual(contextClasses({ payload: { user_profile: deep } }), ['pregnancy_lactation_fertility']);
  for (let i = 0; i < 3000; i += 1) deep = { nested: deep };
  assert.deepEqual(contextClasses({ payload: { user_profile: deep } }), [signal.OVER_LIMIT_CLASS]);
  // the string count is per request, across every place a string is read (each list here is under its own cap)
  const turnsOf = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `neutral ${i}` }));
  assert.deepEqual(contextClasses({ messages: turnsOf(100), payload: { messages: turnsOf(100) } }), []);
  assert.deepEqual(contextClasses({ messages: turnsOf(100), payload: { messages: turnsOf(100), context: { raw_user_goal: 'a serum' } } }), [signal.OVER_LIMIT_CLASS]);
  // every list or object over MAX_SCAN_ARRAY_ITEMS is over the limit, in every reader
  const list = (n, v) => Array.from({ length: n }, () => v);
  const keys = (n, v) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, v]));
  const n = signal.MAX_SCAN_ARRAY_ITEMS;
  // (a status too big to read is also read as affirmative)
  const pregnantOver = [signal.OVER_LIMIT_CLASS, 'pregnancy_lactation_fertility'];
  for (const [name, make, overClasses] of [
    ['profile status list', (m) => ({ payload: { user_profile: { pregnancy_status: list(m, false) } } }), pregnantOver],
    ['profile status object', (m) => ({ payload: { user_profile: { pregnancy_status: keys(m, false) } } }), pregnantOver],
    ['constraint status list', (m) => ({ payload: { constraints: { pregnant: list(m, 'no') } } }), pregnantOver],
    ['message content list', (m) => ({ payload: { messages: [{ role: 'user', content: list(m, 'hi') }] } }), [signal.OVER_LIMIT_CLASS]],
    ['message content object', (m) => ({ payload: { messages: [{ role: 'user', content: keys(m, 'hi') }] } }), [signal.OVER_LIMIT_CLASS]],
    ['constraints object', (m) => ({ payload: { constraints: keys(m, 'none') } }), [signal.OVER_LIMIT_CLASS]],
  ]) {
    assert.deepEqual([name, contextClasses(make(n))], [name, []]);
    assert.deepEqual([name, contextClasses(make(n + 1))], [name, overClasses]);
  }
  // an avoid list with a huge entry is over the limit, and that entry is never viewed (time)
  const t0 = process.hrtime.bigint();
  assert.deepEqual(contextClasses({ payload: { avoid_ingredients: ['z'.repeat(8 * 1024 * 1024)] } }), [signal.OVER_LIMIT_CLASS]);
  const avoidMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(avoidMs < 20, `huge avoid entry took ${avoidMs} ms`);
  assert.deepEqual(contextClasses({ payload: { user_profile: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'])) } }), [signal.OVER_LIMIT_CLASS]);
  assert.deepEqual(contextClasses({ metadata: { safety_flags: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, false])) } }), [signal.OVER_LIMIT_CLASS]);
  assert.deepEqual(contextClasses({ payload: { context: { raw_user_goal: 'y'.repeat(signal.MAX_SCAN_STRING_CHARS + 1) } } }), [signal.OVER_LIMIT_CLASS]);
  assert.deepEqual(contextClasses({ payload: { constraints: { avoid_ingredients: ['z'.repeat(signal.MAX_SCAN_STRING_CHARS + 1)] } } }), [signal.OVER_LIMIT_CLASS]);
  // ordinary context stays within budget and reads as before
  assert.deepEqual(contextClasses({ payload: { messages: Array.from({ length: 30 }, () => ({ role: 'user', content: 'oily skin, want a serum' })) } }), []);
  // a query text over the scan limit gates rather than being read
  assert.deepEqual(signal.retinoidSafetyClassesForText('w'.repeat(signal.MAX_SCAN_STRING_CHARS + 1)), [signal.OVER_LIMIT_CLASS]);
  assert.deepEqual(signal.retinoidSafetyClassesForText('w'.repeat(signal.MAX_SCAN_STRING_CHARS)), []);
});

test('budgets: a wide or deep body costs at most the node budget, in every reader, and gates', () => {
  // Each shape stays under the per-list and depth limits, so only the node budget stops it. Unbounded,
  // each of these took 100-200 ms of one CPU per request.
  const tree = (width, depth, leaf) => (depth === 0 ? leaf : Array.from({ length: width }, () => tree(width, depth - 1, leaf)));
  const otree = (width, depth, leaf) =>
    depth === 0 ? leaf : Object.fromEntries(Array.from({ length: width }, (_, i) => [`k${i}`, otree(width, depth - 1, leaf)]));
  const nested = (n) => JSON.parse('['.repeat(n) + ']'.repeat(n));
  const shapes = {
    'profile status, nested lists': { payload: { user_profile: { pregnant: tree(100, 3, false) } } },
    'profile status, nested objects': { payload: { user_profile: { pregnant: otree(100, 3, false) } } },
    'profile status, 5000 levels deep': { payload: { user_profile: { pregnant: nested(5000) } } },
    'message content, nested lists': { payload: { messages: [{ role: 'user', content: tree(100, 3, []) }] } },
    'message content, nested objects': { payload: { messages: [{ role: 'user', content: otree(100, 3, {}) }] } },
    'profile, nested objects': { payload: { user_profile: otree(100, 3, {}) } },
    'constraints, nested objects': { payload: { constraints: otree(100, 3, {}) } },
    'constraint status, nested objects': { payload: { constraints: { pregnant: otree(100, 3, false) } } },
    'avoid list, nested objects': { payload: { avoid_ingredients: otree(100, 3, {}) } },
    'safety flags, nested lists': { payload: { safety_flags: { flag: tree(100, 3, false) } } },
  };
  for (const [name, body] of Object.entries(shapes)) {
    const t = process.hrtime.bigint();
    const out = signal.retinoidSafetyClassesForRequestContext(body);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(out.classes.includes(signal.OVER_LIMIT_CLASS), `${name}: ${JSON.stringify(out)}`);
    assert.ok(ms < 20, `${name} took ${ms} ms`);
  }
  // just under the node budget reads normally; a profile of ordinary size is far below it
  assert.deepEqual(contextClasses({ payload: { user_profile: { pregnant: tree(40, 2, false) } } }), []);
  assert.deepEqual(contextClasses({ payload: { user_profile: { pregnant: tree(50, 2, false) } } }), [signal.OVER_LIMIT_CLASS, 'pregnancy_lactation_fertility']);
});

test('budgets: once a request is over its limit, nothing more of it is read', () => {
  const marker = `after-the-limit-${Date.now()}`;
  const out = signal.retinoidSafetyClassesForRequestContext({
    messages: [{ role: 'user', content: 'o'.repeat(signal.MAX_SCAN_STRING_CHARS + 1) }, { role: 'user', content: `${marker} one` }],
    payload: { context: { raw_user_goal: `${marker} two` }, safety_flags: [`${marker} three`] },
  });
  assert.deepEqual(out, { classes: [signal.OVER_LIMIT_CLASS], sources: ['over_limit'] });
  // and a status read after the limit is read as it is, not as affirmative
  assert.deepEqual(
    contextClasses({ messages: [{ role: 'user', content: 'o'.repeat(signal.MAX_SCAN_STRING_CHARS + 1) }], payload: { user_profile: { pregnancy_status: 'no' } } }),
    [signal.OVER_LIMIT_CLASS],
  );
  const read = signal._internal.classifyCacheKeys().filter((k) => k.includes(marker));
  assert.deepEqual(read, []);
});

test('the classification cache never keeps a long text', () => {
  for (const n of [257, 1000, 3999]) signal.retinoidSafetyClassesForText(`retinol serum ${'q'.repeat(n)}`);
  signal.retinoidSafetyClassesForRequestContext({ payload: { messages: [{ role: 'user', content: 'p'.repeat(3000) }] } });
  const keys = signal._internal.classifyCacheKeys();
  assert.ok(keys.every((k) => k.length <= 256), `longest cached key: ${Math.max(...keys.map((k) => k.length))}`);
  assert.ok(signal._internal.classifyCacheSize() <= 2000);
});

test('the shared retinoid family: an ester, an acid, a prescription name or a non-English name can be negated too', () => {
  for (const text of [
    'retinyl palmitate free', 'retinyl palmitate free moisturizer', 'no retinyl palmitate', 'retinoic acid free',
    'retinoic acid free cream', 'vitamin a palmitate free', 'serum without vitamin a palmitate', 'differin free', 'tazorac free',
    'rétinoïde free cream', '不含视黄醛', '无阿达帕林', 'レチナールフリー', 'トレチノインなし', '아다팔렌 없는', '트레티노인 프리',
    'без третиноина', 'без адапалена',
  ]) {
    assert.deepEqual(classes(text), ['retinoid_negation'], text);
  }
  // still an ask, as on main
  for (const text of ['retinyl palmitate serum', 'vitamin a palmitate cream', 'retinyl palmitate free shipping', 'retinoic acid cream']) {
    assert.deepEqual(classes(text), [], text);
  }
  // an avoid list naming any family member
  for (const name of ['vitamin A palmitate', 'Differin', 'Epiduo', 'Tazorac', '阿达帕林', 'レチナール', '트레티노인', 'адапален', 'Rétinoïde']) {
    const out = signal.retinoidSafetyClassesForRequestContext({ payload: { constraints: { avoid_ingredients: [name] } } });
    assert.ok(out.classes.includes('retinoid_negation'), name);
  }
});

test('the shared retinoid family: Thai negations, and "vita" / "vitamina" are not vitamin A', () => {
  for (const text of ['ไม่มีเรตินอล', 'ปราศจากเรตินอล', 'ไม่ใช้เรตินอล', 'no vitamin a', 'vit a free', 'differin free', 'sin vitamina a',
    'no vitamina a', 'senza vitamina a', 'sem vitamina a', 'sans vitamine a', 'no vitamins a']) {
    assert.deepEqual(classes(text), ['retinoid_negation'], text);
  }
  for (const text of ['vita coco free', 'sin vitamina c', 'no vitamina c serum', 'vitamina c serum']) {
    assert.deepEqual(classes(text), [], text);
  }
  for (const name of ['Vita Coco', 'vitamina C']) {
    const out = signal.retinoidSafetyClassesForRequestContext({ payload: { constraints: { avoid_ingredients: [name] } } });
    assert.ok(!out.classes.includes('retinoid_negation'), name);
  }
  // a brand in a request still means the retinoid
  for (const name of ['Accutane', 'Differin', 'Aklief']) {
    const out = signal.retinoidSafetyClassesForRequestContext({ payload: { constraints: { avoid_ingredients: [name] } } });
    assert.ok(out.classes.includes('retinoid_negation'), name);
  }
});

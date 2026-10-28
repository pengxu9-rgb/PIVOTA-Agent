// The loopback-only network guard goes first, so nothing below can reach a real host.
require('./agent_readiness_eval/_net_guard.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';
delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;

const app = require('../src/server');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');

const {
  applyRetinoidSafetyNetForInvokeResponse,
  applyRetinoidSafetyNetToSearchBody,
  beautyProductIsRetinoidForSafety,
  beautyProductRetinoidMentionIsStandInOnly,
  buildBeautyMainlineRetrievalQueries,
  getSearchQualityContractHardConstraintResult,
  inferBeautyMainlineIntent,
  isBeautyProductContraindicatedForQuery,
  resolveBeautyRetinoidSafetyClasses,
  runInRetinoidSafetyContextForTest,
  scoreBeautyExternalSeedProduct,
} = app._debug;

const product = (id, title, category, description, extra = {}) => ({
  id,
  product_id: id,
  merchant_id: 'external_seed',
  title,
  category,
  product_type: category,
  description,
  price: 20,
  currency: 'USD',
  image_url: `https://fixture-cdn.invalid/${id}.jpg`,
  ...extra,
});
const RETINOL_SERUM = product('ret_serum', 'Retinol 0.5% Serum', 'serum', 'Face serum with retinol.');
const ACID_TONER = product('acid_toner', 'Glycolic Acid Toning Solution', 'toner', 'Exfoliating toner with glycolic acid.');
const PLAIN_SERUM = product('ha_serum', 'Hyaluronic Acid Serum', 'serum', 'Hydrating face serum.');
const contraindicated = (item, query) => isBeautyProductContraindicatedForQuery(item, query, inferBeautyMainlineIntent(query));

test('intent: legacy pregnancy and retinol-free queries are exactly as before', () => {
  for (const query of ['pregnancy safe serum', 'retinol-free serum', 'no retinol serum', 'ttc serum', '怀孕 精华']) {
    const safety = inferBeautyMainlineIntent(query).safety;
    assert.ok(safety.includes('avoid_retinoids'), query);
    assert.ok(!safety.includes('retinoid_gate_only'), query);
  }
  for (const query of ['moisturizer', 'retinol serum', 'acne treatment', 'sensitive skin serum']) {
    assert.ok(!inferBeautyMainlineIntent(query).safety.includes('avoid_retinoids'), query);
  }
});

test('intent: a new pregnancy word gets the full rule; every other class gates retinoids only', () => {
  for (const query of ['preggo serum', 'serum 임산부', 'breastfeeding serum', 'serum 🤰']) {
    const safety = inferBeautyMainlineIntent(query).safety;
    assert.ok(safety.includes('avoid_retinoids') && !safety.includes('retinoid_gate_only'), query);
  }
  for (const query of ['serum for kids', 'on accutane serum', "don't want retinol serum"]) {
    const safety = inferBeautyMainlineIntent(query).safety;
    assert.ok(safety.includes('avoid_retinoids') && safety.includes('retinoid_gate_only'), query);
  }
});

test('gate: a retinoid is out for every class; exfoliating acids only for the pregnancy class', () => {
  for (const query of ['preggo serum', 'serum for kids', 'on accutane serum', "serum, don't want retinol"]) {
    assert.equal(contraindicated(RETINOL_SERUM, query), true, query);
    assert.equal(contraindicated(PLAIN_SERUM, query), false, query);
  }
  assert.equal(contraindicated(ACID_TONER, 'preggo toner'), true);
  assert.equal(contraindicated(ACID_TONER, 'pregnancy safe toner'), true);
  assert.equal(contraindicated(ACID_TONER, 'toner for kids'), false);
  assert.equal(contraindicated(ACID_TONER, 'on accutane toner'), false);
});

test('retrieval and ranking: pregnancy-safe expansions only for the pregnancy class', () => {
  const pregnancy = buildBeautyMainlineRetrievalQueries('preggo serum');
  assert.ok(pregnancy.includes('retinol free brightening serum'));
  const kids = buildBeautyMainlineRetrievalQueries('serum for kids');
  for (const variant of ['pregnancy safe skincare brightening', 'retinol free brightening serum', 'daily sunscreen pregnancy safe']) {
    assert.ok(pregnancy.includes(variant), variant);
    assert.ok(!kids.includes(variant), variant);
  }
});

test('request context reaches the intent through the per-request store', () => {
  assert.ok(!inferBeautyMainlineIntent('serum').safety.includes('avoid_retinoids'));
  runInRetinoidSafetyContextForTest({ classes: ['pregnancy_lactation_fertility'], sources: ['profile'] }, () => {
    const safety = inferBeautyMainlineIntent('serum').safety;
    assert.ok(safety.includes('avoid_retinoids') && !safety.includes('retinoid_gate_only'));
    assert.deepEqual(resolveBeautyRetinoidSafetyClasses('serum'), ['pregnancy_lactation_fertility']);
  });
  runInRetinoidSafetyContextForTest({ classes: ['child_under_12'], sources: ['profile'] }, () => {
    assert.ok(inferBeautyMainlineIntent('serum').safety.includes('retinoid_gate_only'));
    assert.equal(contraindicated(RETINOL_SERUM, 'retinol serum'), true);
  });
  runInRetinoidSafetyContextForTest({ classes: [], sources: [] }, () => {
    assert.ok(!inferBeautyMainlineIntent('serum').safety.includes('avoid_retinoids'));
  });
});

test('product detection: retinoid names in every script, minus retinoid-free claims', () => {
  for (const [title, description] of [
    ['Retinol Night Cream', ''], ['Retinal Serum', ''], ['Granactive Retinoid Emulsion', ''], ['Tazarotene Cream', ''],
    ['Adapalene Gel', ''], ['Tretinoin Cream', ''], ['Retinyl Palmitate Lotion', ''], ['Night Cream', 'with retinoic acid'],
    ['레티놀 크림', ''], ['レチノール クリーム', ''], ['视黄醇面霜', ''], ['A醇精华', ''], ['Ретинол крем', ''],
  ]) {
    assert.equal(beautyProductIsRetinoidForSafety(product('x', title, 'cream', description)), true, title);
  }
  for (const [title, description] of [
    ['Barrier Cream Retinol-Free', 'Retinol-free face cream.'], ['Hyaluronic Serum', 'Hydrating.'], ['', ''],
  ]) {
    assert.equal(beautyProductIsRetinoidForSafety(product('x', title, 'cream', description)), false, title);
  }
  assert.equal(beautyProductIsRetinoidForSafety(null), false);
});

test('safety net: no id list or generated text still points at a removed product', () => {
  const body = {
    products: [RETINOL_SERUM, PLAIN_SERUM],
    reply: 'Retinol 0.5% Serum is the current lead; Hyaluronic Acid Serum is the comparison.',
    assistant_message: { role: 'assistant', content: 'Try the retinol 0.5% serum tonight.' },
    beauty_expert_v1: { next_actions: [{ type: 'compare', payload: { product_ids: ['ret_serum', 'ha_serum'] } }] },
    metadata: { search_trace: { raw_query: 'retinol 0.5% serum' }, note: 'Retinol 0.5% Serum' },
  };
  const out = applyRetinoidSafetyNetToSearchBody(body, ['child_under_12']);
  assert.deepEqual(out.products.map((p) => p.product_id), ['ha_serum']);
  assert.equal(out.reply, '');
  assert.equal(out.assistant_message.content, '');
  assert.equal(out.assistant_message.role, 'assistant');
  assert.deepEqual(out.beauty_expert_v1.next_actions[0].payload.product_ids, ['ha_serum']);
  // not prose: left as it is
  assert.equal(out.metadata.search_trace.raw_query, 'retinol 0.5% serum');
  assert.equal(out.metadata.note, 'Retinol 0.5% Serum');
  assert.deepEqual(out.metadata.retinoid_safety_net, { removed_count: 1, classes: ['child_under_12'], prose_cleared: 2 });
  // a title too short to be a name ("Gel") never clears prose
  const shortTitle = product('short', 'Gel', 'serum', 'Night gel with retinol.');
  const kept2 = applyRetinoidSafetyNetToSearchBody({ products: [shortTitle, PLAIN_SERUM], reply: 'Gel textures absorb fast.' }, ['x']);
  assert.deepEqual(kept2.products.map((p) => p.product_id), ['ha_serum']);
  assert.equal(kept2.reply, 'Gel textures absorb fast.');
  // prose that names only what is still served is kept
  const kept = applyRetinoidSafetyNetToSearchBody({ products: [RETINOL_SERUM, PLAIN_SERUM], reply: 'Hyaluronic Acid Serum hydrates.' }, ['x']);
  assert.equal(kept.reply, 'Hyaluronic Acid Serum hydrates.');
  assert.equal(kept.metadata.retinoid_safety_net.prose_cleared, undefined);
});

test('contract: a retinoid_forward exclusion now rejects retinoid products', () => {
  const contract = buildSearchQualityContract({ rawQuery: 'pregnancy safe serum', market: 'US' });
  assert.ok(contract.hard_constraints.exclusions.includes('retinoid_forward'));
  const gate = getSearchQualityContractHardConstraintResult(RETINOL_SERUM, contract, 'pregnancy safe serum');
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes('retinoid_forward_excluded'));
  assert.equal(getSearchQualityContractHardConstraintResult(PLAIN_SERUM, contract, 'pregnancy safe serum').eligible, true);
  const plainContract = buildSearchQualityContract({ rawQuery: 'face serum', market: 'US' });
  assert.ok(!getSearchQualityContractHardConstraintResult(RETINOL_SERUM, plainContract, 'face serum').reasons.includes('retinoid_forward_excluded'));
});

test('safety net: removes retinoids from every product list in a body, and nothing else', () => {
  const body = {
    status: 'success',
    total: 3,
    products: [RETINOL_SERUM, PLAIN_SERUM, product('free', 'Retinol-Free Cream', 'cream', 'Retinol-free.')],
    metadata: { query_source: 'x', beauty_mainline_filter: { products: [RETINOL_SERUM, PLAIN_SERUM] } },
    beauty_expert_v1: { reco_bundle: { lead_picks: [RETINOL_SERUM], support_picks: [PLAIN_SERUM] } },
    tags: ['retinol', 'serum'],
  };
  const untouched = applyRetinoidSafetyNetToSearchBody(body, []);
  assert.equal(untouched, body);
  const out = applyRetinoidSafetyNetToSearchBody(body, ['child_under_12']);
  assert.deepEqual(out.products.map((p) => p.product_id), ['ha_serum', 'free']);
  assert.deepEqual(out.metadata.beauty_mainline_filter.products.map((p) => p.product_id), ['ha_serum']);
  assert.deepEqual(out.beauty_expert_v1.reco_bundle.lead_picks, []);
  assert.deepEqual(out.beauty_expert_v1.reco_bundle.support_picks.map((p) => p.product_id), ['ha_serum']);
  assert.deepEqual(out.tags, ['retinol', 'serum']);
  assert.equal(out.total, 2);
  assert.deepEqual(out.metadata.retinoid_safety_net, { removed_count: 3, classes: ['child_under_12'] });
  assert.equal(out.metadata.query_source, 'x');
  // nothing to remove: the very same body comes back
  const clean = { products: [PLAIN_SERUM], total: 1, metadata: {} };
  assert.equal(applyRetinoidSafetyNetToSearchBody(clean, ['child_under_12']), clean);
  // a body without metadata still gets the marker; non-objects pass through
  const bare = applyRetinoidSafetyNetToSearchBody({ products: [RETINOL_SERUM] }, ['x']);
  assert.deepEqual(bare, { products: [], metadata: { retinoid_safety_net: { removed_count: 1, classes: ['x'] } } });
  assert.equal(applyRetinoidSafetyNetToSearchBody(null, ['x']), null);
  assert.deepEqual(applyRetinoidSafetyNetToSearchBody([RETINOL_SERUM], ['x']), [RETINOL_SERUM]);
  // variants are not product lists
  const withVariants = { products: [{ ...PLAIN_SERUM, variants: [{ id: 'v1', title: 'Retinol add-on' }] }] };
  assert.equal(applyRetinoidSafetyNetToSearchBody(withVariants, ['x']), withVariants);
});

test('ranking: pregnancy-safe boosts follow the pregnancy class only', () => {
  const freeCream = product('free_cream', 'Barrier Moisturizer Retinol-Free', 'moisturizer', 'Retinol-free moisturizer with ceramides.');
  const peptideCream = product('peptide_cream', 'Peptide Moisturizer', 'moisturizer', 'Face moisturizer with peptides.');
  const score = (item, classes) => {
    const run = () => {
      const intent = inferBeautyMainlineIntent('moisturizer');
      return scoreBeautyExternalSeedProduct({
        product: item, queryText: 'moisturizer', intent, normalizedQuery: 'moisturizer', queryTokens: ['moisturizer'],
      }).score;
    };
    return classes ? runInRetinoidSafetyContextForTest({ classes, sources: ['profile'] }, run) : run();
  };
  for (const item of [freeCream, peptideCream]) {
    assert.equal(score(item, ['child_under_12']), score(item, null), `${item.id}: child`);
    assert.equal(score(item, ['retinoid_negation']), score(item, null), `${item.id}: negation`);
    assert.notEqual(score(item, ['pregnancy_lactation_fertility']), score(item, null), `${item.id}: pregnancy`);
  }
});

test('invoke net: query texts and request context decide; failures fail closed', () => {
  const body = () => ({ status: 'success', total: 2, products: [RETINOL_SERUM, PLAIN_SERUM], metadata: { query_source: 'x' } });
  const ids = (out) => out.products.map((p) => p.product_id);
  // no signal anywhere: the very same body
  const plain = body();
  assert.equal(applyRetinoidSafetyNetForInvokeResponse({ body: plain, queryTexts: ['retinol serum'] }), plain);
  // a signal in any of the query texts
  assert.deepEqual(ids(applyRetinoidSafetyNetForInvokeResponse({ body: body(), queryTexts: [null, 'retinol serum', '', 'for my 8 year old'] })), ['ha_serum']);
  // each text is read on its own: a negation ending one text does not bind to the name starting the next
  const split = body();
  assert.equal(applyRetinoidSafetyNetForInvokeResponse({ body: split, queryTexts: ['vitamin c serum, no', 'retinol cream', 'vitamin c serum, no'] }), split);
  // a signal in the request context only
  const ctx = { classes: ['pregnancy_lactation_fertility'], sources: ['profile'] };
  assert.deepEqual(ids(applyRetinoidSafetyNetForInvokeResponse({ body: body(), queryTexts: ['retinol serum'], requestContext: ctx })), ['ha_serum']);
  // anything that throws: no products, the response still goes out, and the body says why
  const errors = [];
  const hostile = {
    status: 'success', metadata: { query_source: 'x' }, reply: 'Retinol 0.5% Serum is the lead.', assistant_message: { content: 'x' },
    beauty_expert_v1: { reco_bundle: { lead_picks: [RETINOL_SERUM] } },
  };
  Object.defineProperty(hostile, 'products', { enumerable: true, get() { throw new Error('boom'); } });
  const out = applyRetinoidSafetyNetForInvokeResponse({ body: hostile, queryTexts: ['serum for kids'], onError: (e) => errors.push(e.message) });
  assert.deepEqual(out.products, []);
  assert.equal(out.total, 0);
  assert.deepEqual(out.metadata, { query_source: 'x', retinoid_safety_net: { error: true } });
  assert.equal(out.status, 'success');
  assert.equal(out.reply, '');
  assert.equal(out.assistant_message, undefined);
  assert.equal(out.beauty_expert_v1, undefined);
  assert.deepEqual(errors, ['boom']);
  // a failure on a non-object body passes it through
  assert.equal(applyRetinoidSafetyNetForInvokeResponse({ body: 'x', queryTexts: null }), 'x');
});

test('product detection: Korean and Russian retinoid names on the raw title, description, ingredients and INCI', () => {
  const p = (title, description, seed = {}) => ({ title, description, category: 'serum', seed_data: { description, ...seed } });
  for (const item of [
    p('레티놀 프리미엄 세럼', ''), p('레티날 나이트 크림', ''), p('레티노이드 앰플', ''),
    p('데일리 크림', '보습', { ingredients: ['정제수', '레티닐 팔미테이트'] }), p('나이트 세럼', '', { inci: '정제수, 레티닐팔미테이트' }),
    p('Крем с ретинолом', ''), p('Сыворотка', 'Содержит ретинола 0,3%.'), p('Крем ретиналь', ''), p('Ретиноидная сыворотка', ''),
    p('Night cream', '', { inci_list: ['Aqua', 'ретинол'] }), p('Serum', '', { snapshot: { title: '레티놀 세럼' } }),
    { title: 'Cream', ingredient_intel: { key_ingredients: [{ name: '레티놀' }] } },
  ]) {
    assert.equal(beautyProductIsRetinoidForSafety(item), true, JSON.stringify(item));
  }
  for (const item of [p('히알루론산 수분 세럼', ''), p('시카 진정 크림', ''), p('Увлажняющий крем с гиалуроновой кислотой', ''), p('Ретинолоподобный крем', '')]) {
    assert.equal(beautyProductIsRetinoidForSafety(item), false, JSON.stringify(item));
  }
});

test('product detection: a retinoid named only in a stand-in phrase is not a retinoid product, unless the ingredients name one', () => {
  const p = (title, description = '', seed = {}) => ({
    title, description, category: 'serum', seed_data: { description, ...seed },
    destination_url: `https://fixture-store.invalid/products/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  });
  const standIns = [
    p('Bakuchiol Retinol Alternative Serum'), p('Bio-Retinol Night Cream'), p('Phyto-Retinol Serum'), p('Retinol-Like Serum'),
    p('Retinol Substitute Cream'), p('Plant-Based Retinol Cream'), p('Botanical Retinol Oil'), p('Retinol Replacement Balm'),
    p('Gentle Alternative to Retinol Cream', 'Gentler than retinol.'), p('Retinol Alternative Serum', '', { key_ingredients: ['bakuchiol'] }),
    p('레티놀 대체 세럼'), p('视黄醇平替精华'), p('レチノール代替 美容液'),
  ];
  for (const item of standIns) {
    assert.equal(beautyProductRetinoidMentionIsStandInOnly(item), true, item.title);
    assert.equal(beautyProductIsRetinoidForSafety(item), false, item.title);
  }
  const realRetinoids = [
    p('Bakuchiol Retinol Alternative Serum', '', { inci: ['Aqua', 'Retinol'] }),
    p('Bakuchiol Retinol Alternative Serum', 'Contains 0.1% retinol.'),
    p('Retinol Alternative Serum', '', { key_ingredients: ['retinal'] }),
    p('Retinol Alternative Serum', '', { ingredient_intel: { active_ingredients: ['hydroxypinacolone retinoate'] } }),
    p('Retinol Like Butter Balm'), // no hyphen: a retinol balm, not a stand-in
    p('Retinol Night Cream'), p('레티놀 프리미엄 세럼'), p('Phyto Night Cream with Retinol'),
  ];
  for (const item of realRetinoids) assert.equal(beautyProductIsRetinoidForSafety(item), true, item.title);
  assert.equal(beautyProductRetinoidMentionIsStandInOnly(p('Retinol Night Cream')), false);
  assert.equal(beautyProductRetinoidMentionIsStandInOnly(null), false);
});

test('product detection: the shared retinoid family, and a free claim never hides a retinoid named elsewhere', () => {
  const retinoids = [
    product('x', 'Vitamin A Night Cream', 'cream', ''), product('x', 'Retinyl Palmitate Moisturizer', 'cream', ''),
    product('x', 'Rétinoïde Crème de Nuit', 'cream', ''), product('x', 'Retinoide Nachtcreme', 'cream', ''),
    product('x', 'Differin Adapalene Gel 0.1%', 'gel', ''), product('x', 'Vitamin A Acetate Lip Balm', 'balm', ''),
    product('x', 'Night Cream', 'cream', 'Ingredients: aqua, vitamin a palmitate, glycerin'),
    product('x', '视黄醛精华', 'serum', ''), product('x', 'A醛晚霜', 'cream', ''), product('x', '维A醛面霜', 'cream', ''),
    product('x', '视黄酸乳液', 'lotion', ''), product('x', '阿达帕林凝胶', 'gel', ''), product('x', '他扎罗汀乳膏', 'cream', ''),
    product('x', '曲法罗汀', 'cream', ''), product('x', 'レチナール クリーム', 'cream', ''), product('x', 'トレチノイン', 'cream', ''),
    product('x', 'アダパレン ゲル', 'gel', ''), product('x', 'レチノイド セラム', 'serum', ''), product('x', 'トリファロテン', 'cream', ''),
    product('x', '아다팔렌 겔', 'gel', ''), product('x', '트레티노인 크림', 'cream', ''), product('x', '트리파로텐', 'cream', ''),
    product('x', 'Крем с ретинальдегидом', 'cream', ''), product('x', 'адапален гель', 'gel', ''), product('x', 'третиноин крем', 'cream', ''),
    product('x', 'трифаротен', 'cream', ''),
    // a free claim names what is absent; the retinoid named elsewhere is still there
    product('x', 'Retinol-Free Retinoid Serum (HPR)', 'serum', ''),
    product('x', 'Retinol-Free Night Cream', 'cream', '', { inci: 'Water, Retinyl Palmitate' }),
    product('x', 'Retinol-Free Vitamin A Serum', 'serum', ''),
    // a stand-in title is a retinoid when the ingredients name a family member
    product('x', 'Bakuchiol Retinol Alternative Serum', 'serum', '', { seed_data: { inci: ['Aqua', 'Vitamin A Palmitate'] } }),
    product('x', 'Bio-Retinol Night Cream', 'cream', '', { seed_data: { key_ingredients: ['视黄醛'] } }),
    // a free claim in the title, a script family name elsewhere
    product('x', 'Retinol-Free Night Cream', 'cream', '含视黄醛的晚霜。'),
  ];
  for (const item of retinoids) assert.equal(beautyProductIsRetinoidForSafety(item), true, `${item.title} ${item.inci || item.description}`);
  const notRetinoids = [
    product('x', 'Retinol-Free Bakuchiol Serum', 'serum', ''), product('x', 'Bio-Retinol Night Cream', 'cream', ''),
    product('x', 'Vitamin C Serum', 'serum', ''), product('x', 'Vitamin ACE Body Oil', 'oil', ''),
    product('x', 'Retinol-Free Moisturizer, no retinyl palmitate', 'cream', ''), product('x', '不含视黄醇 面霜 retinol-free', 'cream', ''),
    product('x', 'Retinol-free cream with bakuchiol, a gentler alternative to retinol', 'cream', ''),
    product('x', 'Retinoid-free Vitamin A-free cream', 'cream', ''), product('x', 'Retinol-free レチノールフリー クリーム', 'cream', ''),
    product('x', 'Retinol-Free 레티놀 프리 크림', 'cream', ''), product('x', 'Retinol-free крем без ретинола', 'cream', ''),
    // the claim and a stand-in phrase only in the description
    product('x', 'Bakuchiol Night Cream', 'cream', 'Retinol-free. A gentler alternative to retinol.'),
  ];
  for (const item of notRetinoids) assert.equal(beautyProductIsRetinoidForSafety(item), false, item.title);
});

test('product detection: vitamin A on topical beauty only, a brand by its active, and a free claim in any script', () => {
  const p = (title, category, description = '', extra = {}) => product('x', title, category, description, extra);
  const retinoids = [
    p('Vitamin A Night Cream', 'cream'), p('Vit A Serum', 'serum'), p('Differin Adapalene Gel 0.1% Acne Treatment', 'treatment'),
    p('Vitamin A Free Moisturizer with Retinyl Palmitate', 'moisturizer'),
    // a decimal strength is never a "0% retinol" claim
    p('Retinol 1.0% Serum', 'serum', 'Serum with 1.0% retinol.'), p('1.0% Retinol Night Serum', 'serum'),
    // a claim never spans a sentence or names something else
    p('Night Serum', 'serum', 'With encapsulated retinol. Free shipping on orders over $50.'),
    p('Encapsulated Retinol, Free From Parabens', 'serum'), p('Retinol & Free-Radical Defense Cream', 'cream'),
    p('Night Cream', 'cream', 'Contains retinol; free from parabens.'),
    // a "no" far from the name is not about it
    p('Night Cream', 'cream', 'No parabens. With retinyl palmitate.'),
    p('Retinol-Free Night Cream', 'cream', 'No parabens. With retinyl palmitate.'),
    // "free" that is not this claim, with or without punctuation
    p('Retinol Free Shipping Night Serum', 'serum'), p('Retinol: Free Your Skin Night Serum', 'serum'),
    // only the raw INCI names it
    p('Night Cream', 'cream', '', { inci: 'Aqua, Glycerin, 1.0% Retinol' }),
  ];
  for (const item of retinoids) assert.equal(beautyProductIsRetinoidForSafety(item), true, `${item.title} | ${item.description}`);
  const notRetinoids = [
    p('Prenatal Multivitamin with Vitamin A', 'Supplements'), p('Cod Liver Oil Softgels, Vitamin A & D', 'Health'),
    p('Vitamin A&D Ointment', 'Skin Protectant'), p('Prenatal Vitamins', 'Vitamins', 'Vitamin A (as beta carotene), folate'),
    p('Beta Carotene Provitamin A Face Oil', 'face oil'), p('Vita Coco Hydrating Body Lotion', 'lotion'),
    p('Differin Daily Deep Cleanser', 'cleanser', 'Benzoyl peroxide 5% cleanser'), p('Differin Oil Absorbing Moisturizer SPF 30', 'moisturizer'),
    p('Lip Repair Balm for Accutane Users', 'lip balm'), p('Roaccutane Lip Balm', 'balm'),
    p('Vitamin A Free Moisturizer', 'moisturizer'), p('不含视黄醛的保湿面霜', 'cream'), p('レチナールフリー クリーム', 'cream'),
    p('ไม่มีเรตินอล ครีม', 'cream'), p('Night Cream', 'cream', 'Retinol-free formula.'),
    p('Hair, Skin & Nails Gummies with Vitamin A', 'Skin Care Supplements'), p('Vitamin A 10000 IU', 'Vitamins'),
    p('Retinol Alternative Skin Gummies', 'Supplements', 'With vitamin A.'), p('Pro-Vitamin A Face Oil', 'face oil'),
    p('Night Cream with Vitamin A (as Beta Carotene)', 'cream'), p('Vitamin ACE Body Lotion', 'lotion'),
  ];
  for (const item of notRetinoids) assert.equal(beautyProductIsRetinoidForSafety(item), false, `${item.title} | ${item.description}`);
});

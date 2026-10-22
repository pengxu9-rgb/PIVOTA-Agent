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
  // a signal in the request context only
  const ctx = { classes: ['pregnancy_lactation_fertility'], sources: ['profile'] };
  assert.deepEqual(ids(applyRetinoidSafetyNetForInvokeResponse({ body: body(), queryTexts: ['retinol serum'], requestContext: ctx })), ['ha_serum']);
  // anything that throws: no products, the response still goes out, and the body says why
  const errors = [];
  const hostile = { status: 'success', metadata: { query_source: 'x' } };
  Object.defineProperty(hostile, 'products', { enumerable: true, get() { throw new Error('boom'); } });
  const out = applyRetinoidSafetyNetForInvokeResponse({ body: hostile, queryTexts: ['serum for kids'], onError: (e) => errors.push(e.message) });
  assert.deepEqual(out.products, []);
  assert.equal(out.total, 0);
  assert.deepEqual(out.metadata, { query_source: 'x', retinoid_safety_net: { error: true } });
  assert.equal(out.status, 'success');
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

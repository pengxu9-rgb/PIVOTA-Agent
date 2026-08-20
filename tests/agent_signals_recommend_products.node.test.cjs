// recommend_products — the need-anchored shortlist bridged from the Aurora reco lane to the agent doors.
//
// Pins (handler + projector, lane faked; then the REAL commerce surface with the REAL sanitizer):
//  1. flag dark ⇒ empty + reason 'disabled', lane never called; missing need ⇒ 'need_required', lane never called
//  2. the lane is called with a NAMESPACED synthetic uid per calling agent, no profile, no logs, bounded budget,
//     and the ask built from need + bounded constraints
//  3. lane items project to recommendation Signals with product identity / why / watchouts / grounding;
//     items with no identity are dropped (and counted); limit is honoured; metadata carries confidence_overall,
//     missing_info, warnings
//  4. the lane throwing ⇒ empty + 'lane_unavailable' (never a tool error)
//  4b. a structured price ceiling (price_max/max_price/budget, NUMERIC) is enforced deterministically
//     against the grounded catalog price: conforming items fill the limit first, a violating item is kept
//     only in a leftover slot with fit=low + machine-readable constraint_violations + a leading watchout,
//     and its false budget-fit why[] lines are stripped IN THE BRIDGE (the sanitizer is never asked to
//     catch this). Free-text budgets are out of scope: no parsing of prose.
//  5. through createCommerceToolSurface: the tool is listed with the strict schema, toParams keeps need /
//     constraints / language / limit (and clones constraints), and the SANITIZER keeps why/fit/grounding/
//     confidence_overall while the projector never places a bare `confidence`/`score` on a product node

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { makeRecommendProducts, recommendationItemToSignal, normalizeConstraints, agentLaneUid, extractPriceMax } = require('../src/agentSignals/recommendProducts');

function laneResult(items, extra = {}) {
  return {
    norm: {
      payload: {
        recommendations: items,
        confidence: 0.72,
        missing_info: ['skin type'],
        warnings: ['patch test actives'],
        grounding_status: 'grounded',
        recommendation_meta: { source_mode: 'catalog_grounded' },
        ...extra,
      },
    },
  };
}

// THE FIXTURE IS DERIVED FROM THE LANE'S OWN OUTPUT CONTRACT, not from what the projector happens to
// read. prompts/reco_main_v1_2.user_schema.json `output_schema.recommendations[]` names every field
// below; the grounded extras (price as a {amount,currency} OBJECT, image_url, url/pdp_url, pdp_open,
// grounding_status, notes) are what buildRecoVisibleProductFields + coerceRecoItemForUi attach on the
// catalog-grounded path. A hand-written fixture that matched the projector is exactly how a review
// found the projector reading five fields the lane never emits.
const LANE_SCHEMA = JSON.parse(
  require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'prompts', 'reco_main_v1_2.user_schema.json'), 'utf8'),
).output_schema.recommendations[0];

const ITEM_FULL = {
  slot: 'treatment',
  step: 'treatment',
  score: 88,
  product_type: 'treatment',
  brand: "Paula's Choice",
  name: '2% BHA Liquid Exfoliant',
  display_name: '2% BHA Liquid Exfoliant',
  use_case: 'Unclogs pores and smooths texture',
  concern_match: ['clogged pores', 'uneven texture'],
  skin_fit: ['oily', 'combination'],
  constraint_notes: ['start 2-3x/week to build tolerance'],
  query_terms: ['bha', 'salicylic acid'],
  reasons: ['Leave-on BHA clears pores without scrubbing', 'fragrance-free'],
  sku: { brand: "Paula's Choice", name: '2% BHA Liquid Exfoliant', display_name: '2% BHA Liquid Exfoliant', sku_id: 'sku_1', product_id: 'sig_abc', category: 'Exfoliant' },
  missing_info: [],
  warnings: ['avoid same-night retinol at first'],
  // grounded extras
  merchant_id: 'merch_1',
  price: { amount: 35, currency: 'USD', unknown: false },
  image_url: 'https://img.example/a.jpg',
  url: 'https://shop.example/p/sig_abc',
  pdp_url: 'https://shop.example/p/sig_abc',
  notes: ['well tolerated by sensitive skin'],
  // hostile extras the sanitizer/projector must not carry through
  confidence: 0.9,
  score_breakdown: { relevance: 0.8 },
};

const ITEM_INTERNAL = {
  step: 'moisturizer',
  score: 60,
  name: 'Barrier Cream',
  sku: { product_id: 'sig_int', name: 'Barrier Cream' },
  reasons: ['ceramides support the barrier'],
  price: { amount: 18.5, currency: 'USD' },
  pdp_open: { path: 'ref', product_ref: 'sig_int', get_pdp_v2_payload: { product_ref: 'sig_int' } },
};
const ITEM_UNGROUNDED = { name: 'Some product the lane named but could not resolve', grounding_status: 'ungrounded', reasons: ['cheap'] };
const ITEM_EMPTY = { reasons: ['no identity at all'] };

test('1. dark flag and missing need never reach the lane', async () => {
  let calls = 0;
  const off = makeRecommendProducts({ generate: async () => { calls += 1; return laneResult([ITEM_FULL]); }, isEnabled: () => false });
  const dark = await off({ payload: { need: 'gentle exfoliant' } }, { agent_id: 'agent_a' });
  assert.deepEqual(dark, { subject: { kind: 'need', text: 'gentle exfoliant' }, signals: [], metadata: { reason: 'disabled' } });
  const on = makeRecommendProducts({ generate: async () => { calls += 1; return laneResult([ITEM_FULL]); }, isEnabled: () => true });
  const noNeed = await on({ payload: { constraints: { budget: '$40' } } }, { agent_id: 'agent_a' });
  assert.equal(noNeed.metadata.reason, 'need_required');
  assert.equal(calls, 0);
});

test('2. the lane receives a namespaced agent uid, no profile, bounded budget, and the built ask', async () => {
  let seen = null;
  const h = makeRecommendProducts({
    generate: async (args) => { seen = args; return laneResult([ITEM_FULL]); },
    buildAsk: ({ focus, constraints, lang }) => `ASK[${lang}] ${focus} :: ${JSON.stringify(constraints)}`,
    isEnabled: () => true,
    budgetMs: 4000,
  });
  const res = await h({ payload: { need: '  a gentle retinol for beginners  ', constraints: { budget: 'under $40', avoid: ['fragrance', 'alcohol'], nested: { a: 1 }, __proto__x: 'x', n: 3, b: true }, language: 'cn', limit: 3 } }, { agent_id: 'agent_minds' });
  assert.equal(seen.ctx.aurora_uid, 'agent:agent_minds');
  assert.equal(seen.profile, null);
  assert.deepEqual(seen.recentLogs, []);
  assert.equal(seen.budgetMs, 4000);
  assert.equal(seen.entryType, 'direct');
  assert.equal(seen.recoTriggerSource, 'agent_tool');
  assert.equal(seen.focus, 'a gentle retinol for beginners');
  assert.equal(seen.ctx.lang, 'CN');
  assert.match(seen.message, /^ASK\[CN\] a gentle retinol for beginners :: /);
  // constraints: strings only, arrays joined, numbers/booleans rendered, nested objects stringified
  const asked = JSON.parse(seen.message.split(' :: ')[1]);
  assert.equal(asked.budget, 'under $40');
  assert.equal(asked.avoid, 'fragrance, alcohol');
  assert.equal(asked.n, '3');
  assert.equal(asked.b, 'yes');
  assert.equal(asked.nested, '{"a":1}');
  assert.equal(res.metadata.limit, 3);
  assert.equal(agentLaneUid({}), 'agent:anonymous');
  assert.equal(agentLaneUid({ agent_id: 'x' }), 'agent:x');
  // distinct callers must not share one diversity bucket just because agent_id did not resolve
  assert.equal(agentLaneUid({ invokeAuth: { key_fingerprint: 'abc123' } }), 'agentkey:abc123');
  assert.notEqual(agentLaneUid({ invokeAuth: { key_fingerprint: 'abc123' } }), agentLaneUid({ invokeAuth: { key_fingerprint: 'def456' } }));
});

test('3. projection: identity, why, watchouts, grounding; no-identity items dropped; limit honoured; metadata', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL, ITEM_EMPTY, ITEM_UNGROUNDED, ITEM_FULL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', limit: 2 } }, { agent_id: 'agent_a' });
  assert.equal(res.signals.length, 2);
  const s = res.signals[0];
  assert.equal(s.signal_type, 'recommendation');
  assert.deepEqual(s.subject, { kind: 'product', id: 'sig_abc' });
  assert.equal(s.value.product.price, 35, 'the lane price is an {amount,currency} object');
  assert.equal(s.value.product.currency, 'USD');
  assert.equal(s.value.rank, 1);
  assert.equal(s.value.product.product_id, 'sig_abc');
  assert.equal(s.value.product.merchant_id, 'merch_1');
  assert.equal(s.value.product.title, '2% BHA Liquid Exfoliant');
  assert.equal(s.value.product.url, 'https://shop.example/p/sig_abc');
  assert.deepEqual(s.value.why, [
    'Leave-on BHA clears pores without scrubbing', 'fragrance-free', 'Unclogs pores and smooths texture',
    'clogged pores', 'uneven texture', 'oily', 'combination',
  ]);
  assert.deepEqual(s.value.watchouts, ['start 2-3x/week to build tolerance', 'avoid same-night retinol at first']);
  assert.deepEqual(s.value.notes, ['well tolerated by sensitive skin']);
  assert.equal(s.value.routine_step, 'treatment');
  assert.equal(s.value.product_type, 'treatment');
  assert.equal(s.value.fit.level, 'high', 'the lane score bands, never the raw score');
  assert.equal(s.value.grounding, 'catalog');
  assert.equal(s.evidence.method, 'llm_recommendation_catalog_grounded');
  assert.equal(s.evidence.grade, undefined, 'this lane carries no graded evidence — get_intel does');
  // Every field the fixture takes from the lane contract must be READ or deliberately unread.
  assert.ok(Object.keys(LANE_SCHEMA).length > 10, 'the lane contract fixture must have loaded');
  // the projector never copies a bare confidence/score onto a product node
  assert.equal(s.value.product.confidence, undefined);
  assert.equal(s.confidence, undefined);
  // the projector builds a fresh object, so the hostile keys cannot ride along by construction
  assert.equal(s.value.product.confidence, undefined);
  assert.equal(s.value.product.score, undefined);
  // second signal is the ungrounded named item (the empty one was dropped)
  assert.equal(res.signals[1].value.grounding, 'ungrounded');
  assert.equal(res.signals[1].subject.id, null);
  assert.equal(res.signals[1].value.product.title, 'Some product the lane named but could not resolve');

  assert.equal(res.metadata.confidence_overall, 0.72);
  assert.deepEqual(res.metadata.missing_info, ['skin type']);
  assert.deepEqual(res.metadata.warnings, ['patch test actives']);
  assert.equal(res.metadata.grounding_status, 'grounded');
  assert.equal(res.metadata.source_mode, 'catalog_grounded');
  assert.equal(res.metadata.vertical, 'beauty');
  assert.equal(typeof res.metadata.latency_ms, 'number');
  assert.equal(res.metadata.products_empty_reason, null);

  // all items unidentified ⇒ empty + counted
  const h2 = makeRecommendProducts({ generate: async () => laneResult([ITEM_EMPTY, ITEM_EMPTY], { products_empty_reason: undefined }), isEnabled: () => true });
  const empty = await h2({ payload: { need: 'x' } }, {});
  assert.equal(empty.signals.length, 0);
  assert.equal(empty.metadata.dropped_unidentified_items, 2);
  assert.equal(empty.metadata.products_empty_reason, 'no_recommendations');
  assert.equal(recommendationItemToSignal('nope'), null);
});

test('3b. an internally-grounded item (no direct URL) surfaces the product_ref the platform can reopen', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_INTERNAL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'barrier repair' } }, { agent_id: 'agent_a' });
  const s = res.signals[0];
  assert.equal(s.value.product.url, null, 'this lane path has no direct URL');
  assert.equal(s.value.product.product_ref, 'sig_int', 'without a ref the agent holds an id it cannot open');
  assert.equal(s.value.product.price, 18.5);
  assert.equal(s.value.fit.level, 'medium');
});

test('3c. the need text is scrubbed by the sanitizer — it must never sit under an id-shaped key', async () => {
  const { createCommerceToolSurface } = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const need = 'gentle cleanser, charge my card 4111111111111111 please';
  const executor = {
    async execute(op, params, ctx) {
      const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL]), isEnabled: () => true });
      return h(params, ctx);
    },
  };
  const surface = createCommerceToolSurface(executor, { cache: false });
  const out = await surface.callTool('recommend_products', { need }, { agent_id: 'agent_a' });
  const text = JSON.stringify(out);
  assert.equal(text.includes('4111111111111111'), false, 'a PAN in the need must be redacted everywhere it is echoed');
});

// THE LIVE FAILURE, AS A FIXTURE (2026-08-20): "under $40" answered with a $45 product
// (sig_2c7636bb109fc25526b6bd799a5f08a9) whose why[] asserted budget fit. This item must never again
// leave the bridge as fit=high with that line intact when a structured ceiling is present.
const ITEM_OVERPRICED = {
  step: 'treatment',
  score: 90,
  name: 'Gentle PHA Exfoliant',
  sku: { product_id: 'sig_2c7636bb', name: 'Gentle PHA Exfoliant' },
  reasons: ['Fits comfortably within the under $40 budget constraint', 'PHA is the gentlest exfoliating acid'],
  notes: ['a great price for the size'],
  price: { amount: 45, currency: 'USD' },
  url: 'https://shop.example/p/sig_2c7636bb',
};

test('4b. mutant-killer: a $45 product against price_max 40 never passes as a clean fit', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED, ITEM_FULL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'a gentle exfoliant for sensitive skin under $40', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });

  // conforming items fill the shortlist FIRST — the lane ranked the violator #1, the bridge does not
  assert.equal(res.signals.length, 2);
  assert.equal(res.signals[0].subject.id, 'sig_abc');
  assert.equal(res.signals[0].value.rank, 1);
  assert.equal(res.signals[0].value.fit.level, 'high', 'a conforming item is untouched');
  assert.equal(res.signals[0].value.constraint_violations, undefined);

  const v = res.signals[1];
  assert.equal(v.subject.id, 'sig_2c7636bb');
  assert.equal(v.value.rank, 2);
  assert.notEqual(v.value.fit.level, 'high', 'the violating item must not pass as fit=high');
  assert.equal(v.value.fit.level, 'low');
  assert.deepEqual(v.value.constraint_violations, [{ constraint: 'price_max', limit: 40, price: 45, currency: 'USD' }]);
  assert.equal(v.value.watchouts[0], 'exceeds price_max 40: price 45 USD', 'the marker leads so the cap cannot truncate it');
  assert.equal(v.value.why.some((line) => /budget|price/i.test(line)), false, 'the false budget-fit claim is stripped in the bridge');
  assert.deepEqual(v.value.why, ['PHA is the gentlest exfoliating acid'], 'true non-price reasons survive');
  assert.deepEqual(v.value.notes, [], 'price-praising notes on a violator are stripped too');

  assert.equal(res.metadata.price_max_enforced, 40);
  assert.equal(res.metadata.constraint_violations_returned, 1);
});

test('4c. a violator only takes a LEFTOVER slot — it can never displace a conforming item', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED, ITEM_FULL, ITEM_INTERNAL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { max_price: 40 }, limit: 2 } }, { agent_id: 'agent_a' });
  assert.deepEqual(res.signals.map((s) => s.subject.id), ['sig_abc', 'sig_int'], 'two conforming items fill limit=2; the violator is dropped');
  assert.equal(res.metadata.constraint_violations_returned, 0);
  assert.equal(res.metadata.price_max_enforced, 40);
  assert.equal(res.signals.every((s) => s.value.constraint_violations === undefined), true);
});

test('4d. free-text-only budget is OUT of scope: no prose parsing, no enforcement', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED]), isEnabled: () => true });
  const res = await h({ payload: { need: 'a gentle exfoliant under $40', constraints: { budget: 'under $40' } } }, { agent_id: 'agent_a' });
  const s = res.signals[0];
  assert.equal(s.value.fit.level, 'high', 'no structured ceiling ⇒ the bridge must not guess one from prose');
  assert.equal(s.value.constraint_violations, undefined);
  assert.deepEqual(s.value.why, ['Fits comfortably within the under $40 budget constraint', 'PHA is the gentlest exfoliating acid']);
  assert.equal(res.metadata.price_max_enforced, undefined);
  assert.equal(res.metadata.constraint_violations_returned, undefined);
});

test('4e. extractPriceMax: numeric ceilings only, key variants, smallest wins, prose refused', () => {
  assert.equal(extractPriceMax({ price_max: 40 }), 40);
  assert.equal(extractPriceMax({ max_price: '38', budget: 45 }), 38, 'numeric strings count; the smallest ceiling wins');
  assert.equal(extractPriceMax({ 'price-max': 40 }), 40, 'separator variants canonicalize');
  assert.equal(extractPriceMax({ budget: 'under $40' }), null, 'free text is never parsed');
  assert.equal(extractPriceMax({ price_max: 0 }), null);
  assert.equal(extractPriceMax({ price_max: -5 }), null);
  assert.equal(extractPriceMax({ avoid: 'fragrance' }), null);
  assert.equal(extractPriceMax(undefined), null);
  // an item with no verifiable price is left alone (ungrounded items carry no price by construction)
  const noPrice = { name: 'Named but unresolved', grounding_status: 'ungrounded', reasons: ['gentle'] };
  const h = makeRecommendProducts({ generate: async () => laneResult([noPrice]), isEnabled: () => true });
  return h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {}).then((res) => {
    assert.equal(res.signals[0].value.constraint_violations, undefined);
    assert.equal(res.signals[0].value.fit.level, null);
    assert.equal(res.metadata.constraint_violations_returned, 0);
  });
});

test('4. the lane throwing is an empty, reasoned answer — not a tool error', async () => {
  const h = makeRecommendProducts({ generate: async () => { throw new Error('AURORA_NOT_CONFIGURED'); }, isEnabled: () => true });
  const res = await h({ payload: { need: 'anything' } }, {});
  assert.deepEqual(res.signals, []);
  assert.equal(res.metadata.reason, 'lane_unavailable');
});

test('normalizeConstraints bounds keys/values and refuses prototype keys', () => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v']));
  assert.equal(Object.keys(normalizeConstraints(many)).length, 8);
  assert.deepEqual(normalizeConstraints({ __proto__: { evil: 1 }, constructor: 'x', ok: 'y' }), { ok: 'y' });
  assert.equal(normalizeConstraints({ long: 'a'.repeat(500) }).long.length, 120);
  assert.deepEqual(normalizeConstraints('not an object'), {});
});

test('5. through the real commerce surface: listed, strict schema, toParams, and the sanitizer keeps what matters', async () => {
  const { createCommerceToolSurface } = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const seen = [];
  const executor = {
    async execute(op, params, ctx) {
      seen.push({ op, params, ctx });
      // what the REAL handler would return (see test 3), fed through the surface's sanitizer
      const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL]), isEnabled: () => true });
      return h(params, ctx);
    },
  };
  const surface = createCommerceToolSurface(executor, { cache: false });
  const tool = surface.tools.find((t) => t.name === 'recommend_products');
  assert.ok(tool, 'recommend_products must be listed on the native door');
  assert.deepEqual(tool.inputSchema.required, ['need']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.equal(tool.annotations.idempotentHint, false);

  const constraints = { budget: 'under $40' };
  const out = await surface.callTool('recommend_products', { need: 'gentle exfoliant', constraints, language: 'EN', limit: 2, merchant_id: 'dropped' }, { agent_id: 'agent_a' });
  assert.equal(seen[0].op, 'recommend_products');
  assert.deepEqual(seen[0].params, { payload: { need: 'gentle exfoliant', language: 'EN', limit: 2, constraints: { budget: 'under $40' } } });
  assert.notEqual(seen[0].params.payload.constraints, constraints, 'constraints must be cloned, not aliased');

  const body = typeof out === 'string' ? JSON.parse(out) : (out?.content?.[0]?.text ? JSON.parse(out.content[0].text) : out);
  const sig = body.signals[0];
  assert.equal(sig.value.product.product_id, 'sig_abc');
  assert.deepEqual(sig.value.why.slice(0, 1), ['Leave-on BHA clears pores without scrubbing']);
  assert.equal(sig.value.grounding, 'catalog');
  assert.equal(body.metadata.confidence_overall, 0.72, 'lane-level confidence on metadata survives the sanitizer');
  assert.equal(JSON.stringify(body).includes('score_breakdown'), false);
});

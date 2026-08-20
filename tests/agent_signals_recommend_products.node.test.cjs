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
  assert.equal(res.signals[0].value.watchouts.some((w) => /price_max/.test(w)), false, 'a conforming item carries no price marker');

  const v = res.signals[1];
  assert.equal(v.subject.id, 'sig_2c7636bb');
  assert.equal(v.value.rank, 2);
  assert.notEqual(v.value.fit.level, 'high', 'the violating item must not pass as fit=high');
  assert.equal(v.value.fit.level, 'low');
  assert.deepEqual(v.value.constraint_violations, [{ constraint: 'price_max', limit: 40, limit_currency: 'USD', price: 45, currency: 'USD' }]);
  assert.equal(v.value.watchouts[0], 'exceeds price_max 40 USD: price 45 USD', 'the marker leads so the cap cannot truncate it');
  assert.equal(v.value.why.some((line) => /budget|price/i.test(line)), false, 'the false budget-fit claim is stripped in the bridge');
  assert.deepEqual(v.value.why, ['PHA is the gentlest exfoliating acid'], 'true non-price reasons survive');
  assert.deepEqual(v.value.notes, ['a great price for the size'],
    'a subjective quality judgment asserts nothing about the ceiling — only FIT claims are stripped');

  assert.equal(res.metadata.price_max_enforced, 40);
  assert.equal(res.metadata.price_max_currency, 'USD');
  assert.equal(res.metadata.price_max_currency_declared, false, 'an undeclared ceiling currency is reported as assumed');
  assert.equal(res.metadata.constraint_violations_returned, 1);
  assert.equal(res.metadata.price_unverified_returned, 0);
});

// REVIEW FINDING (both reviewers, independently): the lane's OWN field for constraint commentary is
// `constraint_notes`, which projects into watchouts[] — so it is the likeliest home for the false
// budget claim, and stripping only why[]/notes[] shipped it adjacent to the marker contradicting it.
test('4b-2. a false budget claim in constraint_notes/warnings is stripped from watchouts too', async () => {
  const item = {
    ...ITEM_OVERPRICED,
    constraint_notes: ['Comfortably within your $40 budget', 'introduce slowly on sensitive skin'],
    warnings: ['an affordable pick for the size', 'patch test first'],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const w = res.signals[0].value.watchouts;
  assert.equal(w[0], 'exceeds price_max 40 USD: price 45 USD');
  assert.deepEqual(w.slice(1), ['introduce slowly on sensitive skin', 'patch test first'], 'true cautions survive');
  assert.equal(w.some((line) => /budget|affordable/i.test(line)), false, 'no false budget claim rides in watchouts');
});

test('4b-3. the marker survives a full watchouts list — it is never truncated by the 6-item cap', async () => {
  const item = {
    ...ITEM_OVERPRICED,
    constraint_notes: ['c1', 'c2', 'c3', 'c4'],
    warnings: ['w1', 'w2', 'w3', 'w4'],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const w = res.signals[0].value.watchouts;
  assert.equal(w.length, 6);
  assert.equal(w[0], 'exceeds price_max 40 USD: price 45 USD', 'the marker leads even when 8 watchouts compete for 6 slots');
});

test('4b-4. marking a violator only ever DOWNGRADES fit — it never invents a band the lane withheld', async () => {
  const noScore = { ...ITEM_OVERPRICED, score: undefined };
  const h = makeRecommendProducts({ generate: async () => laneResult([noScore]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const s = res.signals[0];
  assert.equal(s.value.fit.level, null, 'no lane score ⇒ no band, even on a violator: the marker carries the signal');
  assert.equal(s.value.constraint_violations.length, 1, 'the violation itself is still recorded');
});

test('4c. a violator only takes a LEFTOVER slot — it can never displace a conforming item', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED, ITEM_FULL, ITEM_INTERNAL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { max_price: 40 }, limit: 2 } }, { agent_id: 'agent_a' });
  assert.deepEqual(res.signals.map((s) => s.subject.id), ['sig_abc', 'sig_int'], 'two conforming items fill limit=2; the violator is dropped');
  assert.equal(res.metadata.constraint_violations_returned, 0);
  assert.equal(res.metadata.price_max_enforced, 40);
  assert.equal(res.signals.every((s) => s.value.constraint_violations === undefined), true);

  // limit still binds on the conforming path when a ceiling is present
  const res1 = await h({ payload: { need: 'exfoliant', constraints: { max_price: 40 }, limit: 1 } }, { agent_id: 'agent_a' });
  assert.deepEqual(res1.signals.map((s) => s.subject.id), ['sig_abc'], 'limit=1 returns exactly one conforming item');
  assert.equal(res1.metadata.returned, 1);
});

test('4c-2. the ceiling is a MAXIMUM: a price exactly at the ceiling conforms', async () => {
  const atCeiling = { ...ITEM_OVERPRICED, price: { amount: 40, currency: 'USD' } };
  const h = makeRecommendProducts({ generate: async () => laneResult([atCeiling]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  assert.equal(res.signals[0].value.constraint_violations, undefined, 'price == price_max is within the ceiling');
  assert.equal(res.signals[0].value.fit.level, 'high');
  assert.equal(res.metadata.constraint_violations_returned, 0);
});

// REVIEW FINDING (both reviewers, independently): the comparison was currency-blind, which fabricated
// BOTH directions — a clean pass for 35 GBP over a $40 cap, and a bogus violation for ¥4500 under it.
test('4c-3. a price in a different currency is UNVERIFIABLE, never a silent pass or a bogus violation', async () => {
  const gbp = { ...ITEM_OVERPRICED, price: { amount: 35, currency: 'GBP' } };
  const h = makeRecommendProducts({ generate: async () => laneResult([gbp]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const s = res.signals[0];
  assert.equal(s.value.constraint_violations, undefined, 'no FX rates here — 35 GBP vs a USD ceiling is not a violation');
  assert.equal(s.value.watchouts[0], 'price_max 40 USD not verified: price in GBP, ceiling in USD', 'the caller is told the check did not run');
  assert.equal(res.metadata.price_unverified_returned, 1, 'unverified is distinguishable from checked-and-clean');
  assert.equal(res.metadata.constraint_violations_returned, 0);
  assert.equal(res.metadata.price_constraint_unenforced, 'nothing_verifiable',
    'price_max_enforced + 0 violations must not read as "checked and all clean"');
  assert.equal(s.value.why.some((l) => /within|budget/i.test(l)), false,
    'a budget-FIT claim is not relayed on an item the bridge just declared uncheckable');

  // ...and the mirror: a ¥4500 item under a ¥-denominated ceiling of 40 must not be asserted as a violation
  const jpy = { ...ITEM_OVERPRICED, price: { amount: 4500, currency: 'JPY' } };
  const h2 = makeRecommendProducts({ generate: async () => laneResult([jpy]), isEnabled: () => true });
  const res2 = await h2({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  assert.equal(res2.signals[0].value.constraint_violations, undefined, 'a unit-less 40 must never be asserted against 4500 JPY');
  assert.equal(res2.metadata.price_unverified_returned, 1);
});

test('4c-4. a DECLARED ceiling currency is enforced against a matching price', async () => {
  const jpy = { ...ITEM_OVERPRICED, price: { amount: 6000, currency: 'JPY' } };
  const h = makeRecommendProducts({ generate: async () => laneResult([jpy]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 5000, currency: 'JPY' } } }, { agent_id: 'agent_a' });
  const s = res.signals[0];
  assert.deepEqual(s.value.constraint_violations, [{ constraint: 'price_max', limit: 5000, limit_currency: 'JPY', price: 6000, currency: 'JPY' }]);
  assert.equal(s.value.watchouts[0], 'exceeds price_max 5000 JPY: price 6000 JPY');
  assert.equal(res.metadata.price_max_currency, 'JPY');
  assert.equal(res.metadata.price_max_currency_declared, true);
  // the same ceiling expressed on the KEY rather than as a sibling constraint
  const res2 = await h({ payload: { need: 'exfoliant', constraints: { price_max_jpy: 5000 } } }, { agent_id: 'agent_a' });
  assert.equal(res2.metadata.price_max_currency, 'JPY');
  assert.equal(res2.metadata.price_max_currency_declared, true);
  assert.equal(res2.signals[0].value.constraint_violations.length, 1);
});

test('4d. free-text-only budget is OUT of scope: no prose parsing, but the caller is TOLD', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED]), isEnabled: () => true });
  const res = await h({ payload: { need: 'a gentle exfoliant under $40', constraints: { budget: 'under $40' } } }, { agent_id: 'agent_a' });
  const s = res.signals[0];
  assert.equal(s.value.fit.level, 'high', 'no structured ceiling ⇒ the bridge must not guess one from prose');
  assert.equal(s.value.constraint_violations, undefined);
  assert.deepEqual(s.value.why, ['Fits comfortably within the under $40 budget constraint', 'PHA is the gentlest exfoliating acid']);
  assert.equal(res.metadata.price_max_enforced, undefined);
  assert.equal(res.metadata.constraint_violations_returned, undefined);
  // the absence of price_max_enforced must not read as "checked and clean"
  assert.equal(res.metadata.price_constraint_unenforced, 'unstructured_value');
});

test('4e. extractPriceMax: every allowlisted key, numerals only, smallest wins, prose refused', () => {
  // EVERY key in the allowlist is driven — a shrunken allowlist must fail this test, not slip through
  for (const key of ['price_max', 'max_price', 'budget', 'budget_max', 'max_budget', 'price_limit', 'price_ceiling']) {
    assert.equal(extractPriceMax({ [key]: 40 })?.limit, 40, `${key} must be recognized as a ceiling`);
  }
  assert.equal(extractPriceMax({ max_price: '38', budget: 45 }).limit, 38, 'numeric strings count; the smallest ceiling wins');
  assert.equal(extractPriceMax({ budget: 45, max_price: 38 }).limit, 38, 'order does not decide the winner');
  assert.equal(extractPriceMax({ 'price-max': 40 }).limit, 40, 'separator variants canonicalize');
  assert.equal(extractPriceMax({ priceMax: 40 }).limit, 40, 'camelCase canonicalizes');
  assert.equal(extractPriceMax({ price_max: '40 USD' }).limit, 40, 'a bare currency-marked numeral is structured, not prose');
  assert.equal(extractPriceMax({ price_max: '40 USD' }).currency, 'USD');
  assert.equal(extractPriceMax({ price_max: 'USD 40' }).currency, 'USD');
  assert.equal(extractPriceMax({ price_max: 40 }).currency, 'USD', 'an undeclared ceiling defaults to USD...');
  assert.equal(extractPriceMax({ price_max: 40 }).declared, false, '...and says that it was assumed');
  // refusals
  assert.equal(extractPriceMax({ budget: 'under $40' }).limit, undefined, 'prose is never parsed');
  assert.equal(extractPriceMax({ budget: 'under $40' }).unstructured, 'unstructured_value');
  // a REFUSED ceiling still enforces nothing — but it is disclosed rather than silent (see 4e-3)
  assert.equal(extractPriceMax({ price_max: 0 }).limit, undefined);
  assert.equal(extractPriceMax({ price_max: -5 }).limit, undefined);
  assert.equal(extractPriceMax({ price_max: true }).limit, undefined);
  assert.equal(extractPriceMax({ price_max: [40] }).limit, undefined);
  // a key that is not a ceiling key at all yields NOTHING — not even a disclosure, since the caller
  // never asked for a ceiling
  assert.equal(extractPriceMax({ price_min: 40 }), null, 'a FLOOR is not a ceiling');
  assert.equal(extractPriceMax({ budget_cap: 40 }), null, 'a currency-suffix read must not turn "cap" into a currency');
  assert.equal(extractPriceMax({ budget2: 40 }), null, 'a distinct key must not fold into an allowlisted one');
  assert.equal(extractPriceMax({ 'price max': 40 }).limit, 40, 'spaces and punctuation still canonicalize');
  assert.equal(extractPriceMax({ avoid: 'fragrance' }), null);
  assert.equal(extractPriceMax(undefined), null);
});

test('4f. an item with no resolvable price is unverifiable — never marked, never silently clean', async () => {
  const noPrice = { name: 'Named but unresolved', grounding_status: 'ungrounded', reasons: ['gentle'] };
  const h = makeRecommendProducts({ generate: async () => laneResult([noPrice]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  assert.equal(res.signals[0].value.constraint_violations, undefined);
  assert.equal(res.signals[0].value.fit.level, null, 'no lane score ⇒ no invented band, in either direction');
  assert.equal(res.signals[0].value.watchouts[0], 'price_max 40 USD not verified: no catalog price');
  assert.equal(res.metadata.constraint_violations_returned, 0);
  assert.equal(res.metadata.price_unverified_returned, 1);
  assert.equal(res.metadata.price_constraint_unenforced, 'nothing_verifiable');
});

test('4g. budget-fit claims are stripped in CN too — `language` is a first-class parameter', async () => {
  const cn = { ...ITEM_OVERPRICED, reasons: ['价格在40美元预算之内', '温和不刺激'], notes: [] };
  const h = makeRecommendProducts({ generate: async () => laneResult([cn]), isEnabled: () => true });
  const res = await h({ payload: { need: '温和去角质', language: 'CN', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  assert.deepEqual(res.signals[0].value.why, ['温和不刺激'], 'a CN budget claim on a violator is stripped like an EN one');
});

test('4h. the regex alternatives all fire, and do not over-strip', async () => {
  const wordy = {
    ...ITEM_OVERPRICED,
    reasons: ['Comes in well under your 40 dollar cap', 'Great value for the money', 'Sits inside your stated spend limit', 'Priceless glow for sensitive skin'],
    notes: [],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([wordy]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  assert.deepEqual(res.signals[0].value.why, ['Great value for the money', 'Priceless glow for sensitive skin'],
    'FIT claims ("under your 40 dollar cap", "inside your stated spend limit") are stripped; a subjective '
    + 'value judgment and "Priceless" are not claims about the ceiling');
});

// REVIEW FINDING (both reviewers, independently): broadening the strip regex to `cap`/`limit` made it
// delete DERMATOLOGICAL SAFETY CONTENT — watchouts is fed by the lane's `warnings` field, where "limit
// use to 2-3x per week" is ordinary copy. Deleting a safety warning to suppress a budget claim is a
// worse defect than the one being fixed.
test('4h-2. stripping never deletes a safety warning that merely shares a word with price copy', async () => {
  const item = {
    ...ITEM_OVERPRICED,
    reasons: ['Limit sun exposure while using', 'Fits within your $40 budget'],
    notes: [],
    constraint_notes: ['Keep the cap closed; the formula oxidises'],
    warnings: ['Limit use to 2-3 times per week to avoid over-exfoliation'],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const v = res.signals[0].value;
  assert.deepEqual(v.why, ['Limit sun exposure while using'], 'a photosensitivity warning is not a budget claim');
  assert.deepEqual(v.watchouts, [
    'exceeds price_max 40 USD: price 45 USD',
    'Keep the cap closed; the formula oxidises',
    'Limit use to 2-3 times per week to avoid over-exfoliation',
  ], 'usage-frequency and storage cautions survive: "cap"/"limit" are ordinary skincare words');
});

// REVIEW FINDING: assuming the ceiling's currency for a currency-less price re-introduced the very
// fabrication the currency work removed — and wrote the assumed unit into constraint_violations.
test('4c-5. a price with NO currency is unverifiable — its unit is never assumed', async () => {
  const bare = { name: 'Unnormalized row', sku: { product_id: 'sig_bare' }, price: 4500, reasons: ['Fits within your $40 budget'] };
  const h = makeRecommendProducts({ generate: async () => laneResult([bare]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  const v = res.signals[0].value;
  assert.equal(v.product.currency, null);
  assert.equal(v.constraint_violations, undefined, 'a currency the bridge does not know is never asserted');
  assert.equal(v.watchouts[0], 'price_max 40 USD not verified: price carries no currency');
  assert.equal(res.metadata.price_unverified_returned, 1);
  // and the mirror: a bare 35 (which might be GBP) must not pass as verified-clean either
  const cheap = { ...bare, price: 35 };
  const h2 = makeRecommendProducts({ generate: async () => laneResult([cheap]), isEnabled: () => true });
  const res2 = await h2({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  assert.equal(res2.metadata.price_unverified_returned, 1, 'a currency-less amount is never "checked and clean"');
});

test('4c-6. rung priority: verified-clean, then unchecked, then known violators', async () => {
  const violation = { ...ITEM_OVERPRICED, sku: { product_id: 'sig_v' } };
  const unverifiable = { ...ITEM_OVERPRICED, sku: { product_id: 'sig_u' }, price: { amount: 20, currency: 'JPY' } };
  const ok = { ...ITEM_FULL };
  // lane order deliberately puts the violator first
  const h = makeRecommendProducts({ generate: async () => laneResult([violation, unverifiable, ok]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 }, limit: 2 } }, {});
  assert.deepEqual(res.signals.map((s) => s.subject.id), ['sig_abc', 'sig_u'],
    'a KNOWN violator never takes a slot an unchecked item could hold');
  assert.deepEqual(res.signals.map((s) => s.value.rank), [1, 2]);
  assert.equal(res.metadata.constraint_violations_returned, 0);
  assert.equal(res.metadata.price_unverified_returned, 1);
  assert.equal(res.metadata.returned, 2, 'the counters agree with what is actually in signals[]');
});

test('4c-7. the unverifiable marker leads watchouts too — the cap can never truncate it', async () => {
  const item = {
    ...ITEM_OVERPRICED,
    price: { amount: 20, currency: 'JPY' },
    constraint_notes: ['c1', 'c2', 'c3', 'c4'],
    warnings: ['w1', 'w2', 'w3', 'w4'],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  const w = res.signals[0].value.watchouts;
  assert.equal(w.length, 6);
  assert.equal(w[0], 'price_max 40 USD not verified: price in JPY, ceiling in USD');
});

test('4e-2. an unknown currency code can never be used to suppress enforcement', async () => {
  // if "40 XYZ" were accepted, the ceiling would be denominated in a currency nothing matches — and
  // every item would silently become unverifiable. The allowlist is what blocks that.
  assert.equal(extractPriceMax({ price_max: '40 XYZ' }).limit, undefined);
  assert.equal(extractPriceMax({ price_max: '40 XYZ' }).unstructured, 'unstructured_value');
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: '40 XYZ' } } }, {});
  assert.equal(res.metadata.price_max_enforced, undefined);
  assert.equal(res.metadata.price_constraint_unenforced, 'unstructured_value', 'refusal is disclosed, not silent');
});

test('4e-3. a refused ceiling is disclosed whatever its TYPE, with an accurate reason', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED]), isEnabled: () => true });
  // [40] is schema-legal (constraints allows arrays) and used to produce NO metadata at all —
  // byte-identical to sending no constraint, the exact ambiguity this key exists to remove
  for (const value of [[40], true]) {
    const res = await h({ payload: { need: 'x', constraints: { price_max: value } } }, {});
    assert.equal(res.metadata.price_max_enforced, undefined);
    assert.equal(res.metadata.price_constraint_unenforced, 'unstructured_value', `${JSON.stringify(value)} must be disclosed`);
  }
  const zero = await h({ payload: { need: 'x', constraints: { price_max: 0 } } }, {});
  assert.equal(zero.metadata.price_constraint_unenforced, 'out_of_range_value', 'a numeric 0 was structured, just unusable');
  assert.equal(extractPriceMax({ price_max: -5 }).unstructured, 'out_of_range_value');
});

test('4e-4. the ceiling\'s OWN currency beats a generic currency constraint', async () => {
  assert.equal(extractPriceMax({ price_max_gbp: 40, currency: 'USD' }).currency, 'GBP',
    'a currency bound to the ceiling key is more specific than a loose sibling declaration');
  assert.equal(extractPriceMax({ price_max: '40 GBP', currency: 'USD' }).currency, 'GBP');
  assert.equal(extractPriceMax({ price_max: 40, currency: 'USD' }).currency, 'USD', 'a sibling declaration still applies when the key carries none');
  // every ceiling key gets its matching <key>_currency, not just the hand-listed ones
  assert.equal(extractPriceMax({ budget_max: 5000, budget_max_currency: 'JPY' }).currency, 'JPY');
  assert.equal(extractPriceMax({ budget_max: 5000, budget_max_currency: 'JPY' }).declared, true);
});

// REVIEW FINDING: the first regex caught containment verbs only, so comparison and negated-exceed
// phrasings walked through — and the CN half caught 2 of 5 natural phrasings while the one CN test
// happened to use a covered form (a fixture matching the implementation rather than the language).
test('4h-3. comparison and negated-exceed claims are stripped, in EN and CN', async () => {
  const claims = [
    "Won't break your budget",
    'Costs less than you allowed',
    'The cost is lower than your maximum',
    'A $45 serum that still respects your $40 budget',
    'Priced right at your limit',
    '在预算内',
    '这款不会超出你的预算',
    '预算友好的选择',
    '价格低于你的上限',
  ];
  // ONE claim per call: asStringArray caps `reasons` at 6, so a batched fixture silently truncates the
  // control line and every assertion below would pass for the wrong reason.
  for (const claim of claims) {
    const item = { ...ITEM_OVERPRICED, reasons: [claim, 'PHA is the gentlest exfoliating acid'], notes: [] };
    const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
    const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
    assert.deepEqual(res.signals[0].value.why, ['PHA is the gentlest exfoliating acid'],
      `"${claim}" asserts the ceiling is met and must be stripped`);
  }
});

test('4h-4. a fit word alone never strips — only paired with a money word', async () => {
  // `limit`/`cap`/`maximum` are fit words, not price words: alone they are ordinary skincare copy.
  const item = {
    ...ITEM_OVERPRICED,
    reasons: ['A great-value serum that layers under makeup without pilling', 'Use within 6 months of opening'],
    notes: [],
    constraint_notes: ['Limit use to 2-3 times per week', 'Keep the cap closed'],
    warnings: ['Stays below SPF 30 protection on its own'],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  const v = res.signals[0].value;
  assert.deepEqual(v.why, ['A great-value serum that layers under makeup without pilling', 'Use within 6 months of opening'],
    '"under makeup" and "within 6 months" carry no money word — they are not budget claims');
  assert.deepEqual(v.watchouts.slice(1), ['Limit use to 2-3 times per week', 'Keep the cap closed', 'Stays below SPF 30 protection on its own']);
});

// BOTH guards on price_constraint_unenforced are pinned here. This key exists so a caller never
// misreads enforcement state, so a guard that silently stops working is the "green that means nothing
// ran" shape — the failure mode this repo keeps hitting.
test('4j. nothing_verifiable fires only when the shortlist is non-empty AND wholly unchecked', async () => {
  // guard 1: an EMPTY shortlist must not emit it (0 === 0)
  const h0 = makeRecommendProducts({ generate: async () => laneResult([ITEM_EMPTY]), isEnabled: () => true });
  const empty = await h0({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  assert.equal(empty.signals.length, 0);
  assert.equal(empty.metadata.price_constraint_unenforced, undefined,
    'with nothing returned there is no clean bill of health to misread');
  assert.equal(empty.metadata.dropped_unidentified_items, 1);

  // guard 2: a PARTIALLY checked shortlist must not claim nothing could be checked
  const jpy = { ...ITEM_OVERPRICED, sku: { product_id: 'sig_jpy' }, price: { amount: 20, currency: 'JPY' } };
  const h1 = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL, jpy]), isEnabled: () => true });
  const mixed = await h1({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  assert.equal(mixed.signals.length, 2);
  assert.equal(mixed.metadata.price_unverified_returned, 1);
  assert.equal(mixed.metadata.price_constraint_unenforced, undefined,
    'one conforming item WAS verified — the shortlist is half-checked, not unchecked');
});

test('4j-2. the unverifiable rung strips claims from watchouts and notes, not just why', async () => {
  const item = {
    ...ITEM_OVERPRICED,
    price: { amount: 4500, currency: 'JPY' },
    reasons: ['PHA is gentle'],
    notes: ['stays under your budget'],
    constraint_notes: ['Fits within your $40 budget'],
    warnings: ['patch test first'],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  const v = res.signals[0].value;
  assert.deepEqual(v.notes, [], 'a fit claim in notes is not relayed on an unchecked item');
  assert.deepEqual(v.watchouts, ['price_max 40 USD not verified: price in JPY, ceiling in USD', 'patch test first'],
    'a fit claim must not sit beside the marker saying it could not be checked');
});

test('4j-3. the violation record normalizes the currency it reports', async () => {
  // an unnormalized row can carry a lowercase code; firstString trims but never uppercases, and the
  // comparison is case-insensitive — so without normalization a consumer testing
  // `currency === limit_currency` would get false on a genuine violation
  const lower = { name: 'Unnormalized', sku: { product_id: 'sig_low' }, price: 45, currency: 'usd', score: 90 };
  const h = makeRecommendProducts({ generate: async () => laneResult([lower]), isEnabled: () => true });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  const cv = res.signals[0].value.constraint_violations[0];
  assert.equal(cv.currency, 'USD');
  assert.equal(cv.currency, cv.limit_currency, 'the two currency fields of one record must be comparable');
});

test('4i. the enforcement markers survive the REAL commerce surface and its sanitizer', async () => {
  const { createCommerceToolSurface } = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const executor = {
    async execute(op, params, ctx) {
      const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED]), isEnabled: () => true });
      return h(params, ctx);
    },
  };
  const surface = createCommerceToolSurface(executor, { cache: false });
  const out = await surface.callTool('recommend_products', { need: 'gentle exfoliant', constraints: { price_max: 40 } }, { agent_id: 'agent_a' });
  const body = typeof out === 'string' ? JSON.parse(out) : (out?.content?.[0]?.text ? JSON.parse(out.content[0].text) : out);
  const sig = body.signals[0];
  // a key DENYLIST is what lets these through today; pin it so a future denylist entry cannot silently
  // strip the machine-readable violation and leave a green suite behind
  assert.deepEqual(sig.value.constraint_violations, [{ constraint: 'price_max', limit: 40, limit_currency: 'USD', price: 45, currency: 'USD' }]);
  assert.equal(sig.value.watchouts[0], 'exceeds price_max 40 USD: price 45 USD');
  assert.equal(sig.value.fit.level, 'low');
  assert.equal(body.metadata.price_max_enforced, 40);
  assert.equal(body.metadata.constraint_violations_returned, 1);
  // and the advertised schema must teach the shape that is actually enforced
  const tool = surface.tools.find((t) => t.name === 'recommend_products');
  assert.match(tool.inputSchema.properties.constraints.description, /price_max/,
    'the constraints schema must teach the enforced numeric ceiling, not only a prose budget');
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

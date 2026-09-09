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
//  8. THE TWO CONTRACT GUARANTEES THE TOOL DESCRIPTION MAKES (both were violated in prod 2026-09-08):
//     an off-vertical need answers empty with `products_empty_reason: 'off_vertical'` and never calls
//     the lane, and NO returned signal ever carries a null product_id — by either route into one
//  5. through createCommerceToolSurface: the tool is listed with the strict schema, toParams keeps need /
//     constraints / language / limit (and clones constraints), and the SANITIZER keeps why/fit/grounding/
//     confidence_overall while the projector never places a bare `confidence`/`score` on a product node

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { makeRecommendProducts, recommendationItemToSignal, normalizeConstraints, agentLaneUid, extractPriceMax, markPriceViolation, markPriceUnverifiable, offVerticalMarker } = require('../src/agentSignals/recommendProducts');

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
  // The set id is minted before the flag guard (it identifies the REQUEST, not the shortlist), so it
  // is asserted by shape and then removed — keeping this a STRICT whole-response comparison rather
  // than relaxing it to a subset check, which would stop catching an unintended extra key.
  assert.match(dark.metadata.recommendation_set_id, /^rset_[0-9a-f]{24}$/);
  delete dark.metadata.recommendation_set_id;
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
  // warnings LEAD constraint_notes: eviction under the 6-slot cap takes the tail, and the tail must
  // never be the lane's safety field (post-#2037 review: markers + bookkeeping evicted all 4 warnings).
  assert.deepEqual(s.value.watchouts, ['avoid same-night retinol at first', 'start 2-3x/week to build tolerance']);
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
  // The second slot goes to the later CATALOG item, not to the ungrounded advisory the lane ranked
  // ahead of it. The empty item is still dropped.
  assert.equal(res.signals[1].value.grounding, 'catalog');
  assert.equal(res.signals[1].subject.id, 'sig_abc');
  // EVEN WITH ROOM, the ungrounded item does not appear: it is suppressed, not demoted. Its archetype
  // survives as TEXT on metadata, where it carries no product identity to be mistaken for one.
  const wide = await h({ payload: { need: 'exfoliant', limit: 5 } }, { agent_id: 'agent_a' });
  assert.equal(wide.signals.length, 2, 'the ungrounded advisory takes no slot at any limit');
  assert.ok(wide.signals.every((x) => x.value.grounding === 'catalog'));
  assert.equal(wide.metadata.ungrounded_suppressed, 1);
  assert.deepEqual(wide.metadata.unresolved_archetypes, ['Some product the lane named but could not resolve']);
  assert.equal(wide.metadata.ungrounded_returned, undefined, 'the old key is gone, not merely zero');
  assert.equal(res.metadata.ungrounded_suppressed, 1);

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
  assert.deepEqual(w.slice(1), ['patch test first', 'introduce slowly on sensitive skin'],
    'true cautions survive (warnings lead: safety is last to evict)');
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
  // GROUNDED with no price. The fixture used to be an ungrounded item, which the grounding suppression
  // now drops before the ceiling pass ever sees it — leaving this rung untested while still green. A
  // catalog row with a missing price is the real shape this rung exists for (offer_price_missing).
  const noPrice = { name: 'Priced nowhere', sku: { product_id: 'sig_noprice' }, reasons: ['gentle'] };
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
    'Limit use to 2-3 times per week to avoid over-exfoliation',
    'Keep the cap closed; the formula oxidises',
  ], 'usage-frequency and storage cautions survive: "cap"/"limit" are ordinary skincare words');
});

// POST-MERGE REVIEW BLOCKER (2026-08-20, reproduced by execution): bare `spend`/`cost` in the price-token
// set paired with the fit word `limit` deleted PHOTOSENSITIVITY WARNINGS — "Limit the time you spend in
// the sun" — on exactly the AHA/PHA population this tool serves. These fixtures are the reviewer's
// reproduced deletions, verbatim. They must survive on EVERY enforcement path.
const SUN_SAFETY_WARNINGS = [
  'Limit the time you spend in the sun while using this',
  'Reduce the time you spend under direct sunlight after applying',
  'Keep sun exposure to a minimum; this acid costs you UV tolerance',
  'Wear SPF 30 or higher - AHAs increase sun sensitivity',
];

test('4h-3. photosensitivity warnings with time-spend/cost wording survive on a violator', async () => {
  const item = { ...ITEM_OVERPRICED, warnings: SUN_SAFETY_WARNINGS, constraint_notes: [] };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const w = res.signals[0].value.watchouts;
  assert.equal(w[0], 'exceeds price_max 40 USD: price 45 USD');
  assert.deepEqual(w.slice(1), SUN_SAFETY_WARNINGS,
    '"time you spend in the sun" / "costs you UV tolerance" are not budget claims — deleting a safety '
    + 'warning to suppress a price claim is a worse defect than the one being fixed');
});

test('4h-4. the same warnings survive the UNVERIFIABLE path — it strips with the same regexes', async () => {
  // blast radius: unverifiable fires for EVERY item when the catalog currency ≠ ceiling currency, so an
  // over-strip here hits whole non-USD populations, not just violators.
  const item = { ...ITEM_OVERPRICED, price: { amount: 4500, currency: 'JPY' }, warnings: SUN_SAFETY_WARNINGS, constraint_notes: [] };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const w = res.signals[0].value.watchouts;
  assert.match(w[0], /not verified/, 'the unverifiable marker still leads');
  assert.deepEqual(w.slice(1), SUN_SAFETY_WARNINGS, 'no safety warning is deleted on the unverifiable path');
});

test('4h-5. amount-free monetary idioms of spend/cost still strip — the fix is a re-expression, not a retreat', async () => {
  const item = {
    ...ITEM_OVERPRICED,
    reasons: [
      'Sits inside your stated spend limit',
      'Costs less than you allowed',
      'The cost is lower than your maximum',
      'Her spending cap is respected here',
      'PHA is the gentlest exfoliating acid',
    ],
    notes: [],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([item]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  assert.deepEqual(res.signals[0].value.why, ['PHA is the gentlest exfoliating acid'],
    'compound-noun ("spend limit", "spending cap") and comparative ("costs less", "cost is lower") money '
    + 'idioms are still recognized without a dollar amount in the line');
});

// POST-MERGE REVIEW MAJOR: the unenforced-constraint disclosure was guarded on `!enforcing`, so
// `{price_max: 40, budget: 'under $30'}` reported "enforced at 40" with NO hint that the buyer's tighter
// prose ceiling was dropped — exactly the "absent marker read as a clean bill of health" failure the
// disclosure exists to prevent.
test('4k. an unreadable second constraint is disclosed even when a structured ceiling IS enforced', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED, ITEM_FULL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40, budget: 'under $30' } } }, { agent_id: 'agent_a' });
  assert.equal(res.metadata.price_max_enforced, 40, 'the readable ceiling is still enforced');
  assert.equal(res.metadata.price_constraint_unenforced, 'unstructured_value',
    'the dropped prose ceiling is said out loud alongside the enforced one');
});

// THE LIVE SHAPE OF 2026-08-20, SECOND ROUND: an invented "Hydrating Amino Acid Gel Cleanser"
// (ungrounded, no price, no url) rode fit=high at rank #1 ABOVE the flagged $45 catalog item. That was
// first fixed by DEMOTING the invention to the last slot. 2026-09-08 showed demotion was not enough:
// a "Daily Broad Spectrum SPF 30 Sunscreen" with every identity field null still reached a partner
// agent at rank 3 of 3, in a tool that promises "never with fabricated products". It is suppressed now.
test('5. an ungrounded advisory is suppressed entirely — it takes no slot, at any limit', async () => {
  const phantom = {
    name: 'Hydrating Amino Acid Gel Cleanser',
    grounding_status: 'ungrounded',
    score: 92, // the lane scored its own invention highly — no band, and no slot, survives projection
    reasons: ['Amino acid surfactants cleanse without stripping'],
  };
  // lane order deliberately puts the phantom first, as the live lane did
  const h = makeRecommendProducts({ generate: async () => laneResult([phantom, ITEM_OVERPRICED]), isEnabled: () => true });
  const res = await h({ payload: { need: 'a gentle exfoliant for sensitive skin under $40', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  assert.deepEqual(res.signals.map((s) => [s.value.grounding, s.value.rank]), [['catalog', 1]],
    'the flagged real item is the whole shortlist; the invention is gone, not demoted');
  assert.equal(res.signals[0].value.fit.level, 'low', 'the violator stays flagged');
  assert.equal(res.metadata.ungrounded_suppressed, 1);
  assert.deepEqual(res.metadata.unresolved_archetypes, ['Hydrating Amino Acid Gel Cleanser']);
  assert.equal(res.metadata.constraint_violations_returned, 1);

  // and without a ceiling — the leftover-slot path that actually shipped the 2026-09-08 defect
  const h2 = makeRecommendProducts({ generate: async () => laneResult([phantom, ITEM_FULL]), isEnabled: () => true });
  const res2 = await h2({ payload: { need: 'cleanser', limit: 10 } }, { agent_id: 'agent_a' });
  assert.deepEqual(res2.signals.map((s) => s.value.grounding), ['catalog'],
    'a limit far above the item count still buys the invention no slot');
  assert.equal(res2.metadata.ungrounded_suppressed, 1);

  // a shortlist that was ONLY inventions is empty, and says which kind of empty it is
  const h3 = makeRecommendProducts({ generate: async () => laneResult([phantom]), isEnabled: () => true });
  const res3 = await h3({ payload: { need: 'cleanser' } }, { agent_id: 'agent_a' });
  assert.deepEqual(res3.signals, []);
  assert.equal(res3.metadata.products_empty_reason, 'no_grounded_recommendations',
    "the lane DID answer — blaming it for 'no_recommendations' would point at the wrong fix");
});

// LIVE PRICE RE-VERIFICATION: the lane's price is a catalog snapshot; the injected verifyPrice resolves
// the live PDP/offer lane BEFORE the ceiling is enforced, so the gate judges the price the buyer would
// actually see. A failed or slow check degrades to the snapshot, explicitly marked — never an error.
test('6. verifyPrice corrects a stale snapshot BEFORE the ceiling pass, and marks every outcome', async () => {
  // catalog says 35 (conforming) but the live offer is 45: the gate must flag it
  const stale = { ...ITEM_FULL };
  const calls = [];
  const h = makeRecommendProducts({
    generate: async () => laneResult([stale]),
    isEnabled: () => true,
    verifyPrice: async ({ product_id }) => { calls.push(product_id); return { price: 45, currency: 'USD', in_stock: true }; },
  });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  assert.deepEqual(calls, ['sig_abc'], 'the grounded item is verified exactly once');
  const v = res.signals[0].value;
  assert.equal(v.product.price, 45, 'the live price replaces the snapshot');
  assert.equal(v.product.price_verified, true);
  assert.deepEqual(v.constraint_violations, [{ constraint: 'price_max', limit: 40, limit_currency: 'USD', price: 45, currency: 'USD' }],
    'the ceiling is enforced against the LIVE price, not the stale snapshot');
  assert.equal(v.watchouts.some((w) => /price updated by live check: 35 USD -> 45 USD/.test(w)), true);
  assert.deepEqual(res.metadata.price_verification, { checked: 1, confirmed: 0, updated: 1, unavailable: 0, unresolvable: 0, unchecked: 0 });
});

test('6b. a confirmed price is marked verified; a failed check degrades to the snapshot, marked', async () => {
  const h = makeRecommendProducts({
    generate: async () => laneResult([ITEM_FULL, ITEM_INTERNAL]),
    isEnabled: () => true,
    verifyPrice: async ({ product_id }) => {
      if (product_id === 'sig_abc') return { price: 35, currency: 'USD' };
      throw new Error('pdp lane down');
    },
  });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, { agent_id: 'agent_a' });
  const [a, b] = res.signals.map((s) => s.value);
  assert.equal(a.product.price_verified, true);
  assert.equal(a.watchouts.some((w) => /price updated/.test(w)), false, 'a confirmed price earns no watchout');
  assert.equal(b.product.price_verified, false, 'a thrown check degrades to the snapshot, marked');
  assert.equal(b.product.price, 18.5, 'the snapshot price is kept');
  assert.deepEqual(res.metadata.price_verification, { checked: 2, confirmed: 1, updated: 0, unavailable: 1, unresolvable: 0, unchecked: 0 });
  // both still conform to the ceiling on the prices the bridge holds
  assert.equal(res.metadata.constraint_violations_returned, 0);
});

test('6c. no verifier wired ⇒ no price_verified keys, no metadata block — old behavior, byte-stable', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant' } }, { agent_id: 'agent_a' });
  assert.equal(res.signals[0].value.product.price_verified, undefined);
  assert.equal(res.metadata.price_verification, undefined);
});

test('6d. ungrounded items are never sent to the verifier — there is nothing to verify', async () => {
  const calls = [];
  const h = makeRecommendProducts({
    generate: async () => laneResult([ITEM_UNGROUNDED, ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: async ({ product_id }) => { calls.push(product_id); return { price: 35, currency: 'USD' }; },
  });
  const res = await h({ payload: { need: 'cleanser' } }, { agent_id: 'agent_a' });
  assert.deepEqual(calls, ['sig_abc']);
  assert.equal(res.signals.length, 1, 'the advisory is suppressed, so only the catalog item remains');
  assert.equal(res.metadata.ungrounded_suppressed, 1);
  assert.deepEqual(res.metadata.price_verification, { checked: 1, confirmed: 1, updated: 0, unavailable: 0, unresolvable: 0, unchecked: 0 });
});

test('6e. an out-of-stock live check is said out loud on the item', async () => {
  const h = makeRecommendProducts({
    generate: async () => laneResult([ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: async () => ({ price: 35, currency: 'USD', in_stock: false }),
  });
  const res = await h({ payload: { need: 'exfoliant' } }, { agent_id: 'agent_a' });
  assert.equal(res.signals[0].value.watchouts[0], 'live availability check: out of stock');
});

// POST-PR ADVERSARIAL REVIEW (2026-08-20), findings 1-4 — each was a mutant the suite could not kill.
test('6f. a live price of 0 or negative is a broken offer row, never a verified within-budget pass', async () => {
  for (const bad of [0, -10]) {
    const h = makeRecommendProducts({
      generate: async () => laneResult([ITEM_OVERPRICED]),
      isEnabled: () => true,
      verifyPrice: async () => ({ price: bad, currency: 'USD' }),
    });
    const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
    const v = res.signals[0].value;
    assert.equal(v.product.price, 45, `live ${bad} never replaces the snapshot`);
    assert.equal(v.product.price_verified, false);
    assert.equal(v.fit.level, 'low', 'the $45 violation stands, judged on the snapshot');
    assert.deepEqual(v.constraint_violations?.map((x) => x.price), [45]);
    assert.equal(res.metadata.price_verification.unavailable, 1);
  }
});

test('6g. an unrecognized live currency cannot launder a violation into "unverifiable"', async () => {
  const h = makeRecommendProducts({
    generate: async () => laneResult([ITEM_OVERPRICED]),
    isEnabled: () => true,
    verifyPrice: async () => ({ price: 45, currency: 'XYZ' }),
  });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  const v = res.signals[0].value;
  assert.equal(v.product.currency, 'USD', 'the snapshot currency is kept');
  assert.equal(v.product.price_verified, false);
  assert.equal(v.fit.level, 'low', 'the same KNOWN_CURRENCIES allowlist that guards the ceiling guards the live side');
  assert.equal(res.metadata.constraint_violations_returned, 1);
});

test('6h. a returned item the verifier never saw is marked and counted — absence is not coverage', async () => {
  // 8 grounded items, limit 5, ceiling 40: lane positions 0-6 violate at 50, position 7 conforms at 20.
  // Re-slotting returns the conforming item at rank #1 — from BEYOND the verification window.
  const items = Array.from({ length: 7 }, (_, i) => ({
    ...ITEM_FULL, sku: { product_id: `sig_v${i}`, name: `Overpriced ${i}` }, price: { amount: 50, currency: 'USD' },
  }));
  items.push({ ...ITEM_FULL, sku: { product_id: 'sig_cheap', name: 'Conforming' }, price: { amount: 20, currency: 'USD' } });
  const checked = [];
  const h = makeRecommendProducts({
    generate: async () => laneResult(items),
    isEnabled: () => true,
    verifyPrice: async ({ product_id }) => { checked.push(product_id); return { price: 50, currency: 'USD' }; },
  });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 }, limit: 5 } }, {});
  assert.equal(checked.includes('sig_cheap'), false, 'the fixture holds: #1 was outside the window');
  const top = res.signals[0];
  assert.equal(top.subject.id, 'sig_cheap');
  assert.equal(top.value.product.price_verified, false, 'unchecked is said on the item');
  assert.equal(res.metadata.price_verification.unchecked, 1, 'and counted in the tallies');
  assert.equal(res.metadata.price_verification.checked, 7);
});

test('6i. verification bookkeeping evicts constraint_notes, never the lane safety warnings', async () => {
  const item = {
    ...ITEM_OVERPRICED,
    price: { amount: 45, currency: 'USD' },
    constraint_notes: ['c1', 'c2', 'c3', 'c4'],
    warnings: ['SAFETY: limit sun exposure', 'SAFETY: patch test', 'SAFETY: not with retinol', 'SAFETY: avoid in pregnancy'],
  };
  const h = makeRecommendProducts({
    generate: async () => laneResult([item]),
    isEnabled: () => true,
    verifyPrice: async () => ({ price: 60, currency: 'USD', in_stock: false }),
  });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  const w = res.signals[0].value.watchouts;
  assert.equal(w.length, 6);
  assert.equal(w.filter((x) => /^SAFETY:/.test(x)).length, 3,
    'three bookkeeping lines take three slots; the remaining three go to safety warnings, not constraint_notes');
  assert.equal(w.some((x) => /^c\d$/.test(x)), false, 'constraint_notes are what eviction takes');
});

test('6j. without a ceiling only the items that can RETURN are verified — no fan-out for unreachable slots', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    ...ITEM_FULL, sku: { product_id: `sig_${i}`, name: `Item ${i}` },
  }));
  const checked = [];
  const h = makeRecommendProducts({
    generate: async () => laneResult(items),
    isEnabled: () => true,
    verifyPrice: async ({ product_id }) => { checked.push(product_id); return { price: 35, currency: 'USD' }; },
  });
  const res = await h({ payload: { need: 'x', limit: 3 } }, {});
  assert.equal(checked.length, 3, 'no ceiling ⇒ the first `limit` grounded items ARE the shortlist; nothing else is checked');
  assert.equal(res.signals.length, 3);
});

test('6k. latency_ms includes the verification pass the partner actually waited for', async () => {
  const h = makeRecommendProducts({
    generate: async () => laneResult([ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: () => new Promise((resolve) => setTimeout(() => resolve({ price: 35, currency: 'USD' }), 60)),
  });
  const res = await h({ payload: { need: 'x' } }, {});
  assert.ok(res.metadata.latency_ms >= 50, `latency_ms=${res.metadata.latency_ms} must cover the ~60ms verify pass`);
});

// CHAIN CONTRACT (2026-08-26, live repro): the lane's top picks answered NO_MERCHANT_OFFER on
// get_product — the reco corpus is Aurora's, and nothing here checked that the id an item ADVERTISES
// resolves on the read chain that serves it. The public search projector already enforces "never
// advertise a product_id that get_product cannot resolve"; these tests pin the same rule onto this
// surface. The signal rides the existing verifyPrice loopback: a DEFINITIVE `{unresolvable: true}`
// (HTTP 404 + PRODUCT_NOT_FOUND envelope, classified in the server.js wiring) drops the item; every
// other failure stays "price unavailable" — cannot-verify must never buy a delisting.
test('6l. a definitively unresolvable id is dropped and its slot backfills; the drop is counted', async () => {
  const dead = { ...ITEM_FULL, sku: { product_id: 'sig_dead', name: 'Dead Pick' } };
  const checked = [];
  const h = makeRecommendProducts({
    generate: async () => laneResult([dead, ITEM_FULL, ITEM_INTERNAL]),
    isEnabled: () => true,
    verifyPrice: async ({ product_id }) => {
      checked.push(product_id);
      if (product_id === 'sig_dead') return { unresolvable: true };
      return { price: 35, currency: 'USD' };
    },
  });
  const res = await h({ payload: { need: 'exfoliant', limit: 2 } }, { agent_id: 'agent_a' });
  assert.deepEqual(checked, ['sig_dead', 'sig_abc'], 'the window covered the first two grounded items');
  assert.deepEqual(res.signals.map((s) => s.subject.id), ['sig_abc', 'sig_int'],
    'the dead pick is gone and the next grounded item takes its slot');
  assert.equal(JSON.stringify(res).includes('sig_dead'), false,
    'the dead id appears NOWHERE in the response — not even a diagnostic field may hand it to an agent');
  assert.equal(res.signals[0].value.product.price_verified, true);
  assert.equal(res.signals[1].value.product.price_verified, false, 'the backfilled item is honestly unchecked');
  assert.deepEqual(res.metadata.price_verification,
    { checked: 2, confirmed: 1, updated: 0, unavailable: 0, unresolvable: 1, unchecked: 1 });
});

test('6m. unresolvable must be the PROVEN envelope — null, a thrown check, and a truthy-but-not-true flag all keep the item', async () => {
  for (const answer of [null, () => { throw new Error('pdp lane down'); }, { unresolvable: 1 }, { unresolvable: 'true' }]) {
    const h = makeRecommendProducts({
      generate: async () => laneResult([ITEM_FULL]),
      isEnabled: () => true,
      verifyPrice: async () => (typeof answer === 'function' ? answer() : answer),
    });
    const res = await h({ payload: { need: 'exfoliant' } }, { agent_id: 'agent_a' });
    assert.equal(res.signals.length, 1, `answer ${JSON.stringify(String(answer))} must not buy a delisting`);
    assert.equal(res.signals[0].subject.id, 'sig_abc');
    assert.equal(res.signals[0].value.product.price_verified, false, 'it degrades to unverified, marked');
    assert.equal(res.metadata.price_verification.unresolvable, 0);
    assert.equal(res.metadata.price_verification.unavailable, 1);
  }
});

test('6o. the HTTP classifier: which 404s are definitive, which must be confirmed, which prove nothing', () => {
  const classify = require('../src/agentSignals/recommendProducts').classifyVerifyPriceResponse;
  // DEFINITIVE, no confirmation needed — envelopes only a successful read can produce:
  // PRODUCT_NOT_SERVABLE (post-eligibility-read; the incident cohort finding 2 named), and
  // PRODUCT_NOT_FOUND carrying details.reason (e.g. the external_seed_not_active precheck).
  assert.deepEqual(classify(404, { error: 'PRODUCT_NOT_SERVABLE' }), { unresolvable: true });
  assert.deepEqual(classify(404, { reasonCode: 'PRODUCT_NOT_SERVABLE' }), { unresolvable: true });
  assert.deepEqual(classify(404, { error: 'PRODUCT_NOT_FOUND', details: { reason: 'external_seed_not_active' } }),
    { unresolvable: true });
  // AMBIGUOUS — the bare rescue-fail emit: a transient dependency blip mints the same body as a
  // truly absent row, so it must be seen twice (both envelope spellings).
  assert.deepEqual(classify(404, { error: 'PRODUCT_NOT_FOUND' }), { unresolvable: true, confirm: true });
  assert.deepEqual(classify(404, { reasonCode: 'PRODUCT_NOT_FOUND' }), { unresolvable: true, confirm: true });
  assert.deepEqual(classify(404, { error: 'PRODUCT_NOT_FOUND', details: {} }), { unresolvable: true, confirm: true },
    'an empty details object carries no reason and stays ambiguous');
  // PROVES NOTHING: a 404 without either code (a proxy, a route miss) must not buy a delisting
  assert.equal(classify(404, {}), null);
  assert.equal(classify(404, null), null);
  assert.equal(classify(404, 'Not Found'), null);
  assert.equal(classify(404, { error: 'SOMETHING_ELSE' }), null);
  // other failures degrade to "price unavailable"
  assert.equal(classify(500, { error: 'PRODUCT_NOT_FOUND' }), null, 'the code without the status is not the envelope');
  assert.equal(classify(500, { error: 'PRODUCT_NOT_SERVABLE' }), null);
  assert.equal(classify(503, {}), null);
  assert.equal(classify(302, {}), null);
  // 2xx: the caller reads the price itself
  assert.equal(classify(200, { modules: [] }), undefined);
  assert.equal(classify(204, null), undefined);
});

test('6p. the ambiguous envelope is probed twice: a second answer wins the item back; a repeat buys the drop', async () => {
  // (a) blip on the first probe, real price on the second: the item is KEPT and live-verified
  let calls = 0;
  const blipThenPrice = makeRecommendProducts({
    generate: async () => laneResult([ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: async () => {
      calls += 1;
      return calls === 1 ? { unresolvable: true, confirm: true } : { price: 35, currency: 'USD' };
    },
  });
  const kept = await blipThenPrice({ payload: { need: 'exfoliant' } }, { agent_id: 'agent_a' });
  assert.equal(calls, 2, 'the ambiguous answer costs exactly one extra probe');
  assert.equal(kept.signals.length, 1);
  assert.equal(kept.signals[0].value.product.price_verified, true, 'the second probe answer is USED, not discarded');
  assert.equal(kept.metadata.price_verification.unresolvable, 0);

  // (b) the same ambiguous envelope twice: two independent probes agree — dropped
  calls = 0;
  const blipTwice = makeRecommendProducts({
    generate: async () => laneResult([ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: async () => { calls += 1; return { unresolvable: true, confirm: true }; },
  });
  const dropped = await blipTwice({ payload: { need: 'exfoliant' } }, { agent_id: 'agent_a' });
  assert.equal(calls, 2);
  assert.equal(dropped.signals.length, 0);
  assert.equal(dropped.metadata.price_verification.unresolvable, 1);

  // (c) a DEFINITIVE answer needs no confirmation: exactly one probe, dropped
  calls = 0;
  const definitive = makeRecommendProducts({
    generate: async () => laneResult([ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: async () => { calls += 1; return { unresolvable: true }; },
  });
  const gone = await definitive({ payload: { need: 'exfoliant' } }, { agent_id: 'agent_a' });
  assert.equal(calls, 1, 'a definitive envelope must not spend a second loopback');
  assert.equal(gone.signals.length, 0);
});

test('6q. an all-dropped shortlist says WHY — and does not blame identity', async () => {
  const h = makeRecommendProducts({
    generate: async () => laneResult([ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: async () => ({ unresolvable: true }),
  });
  const res = await h({ payload: { need: 'exfoliant' } }, { agent_id: 'agent_a' });
  assert.equal(res.signals.length, 0);
  assert.equal(res.metadata.products_empty_reason, 'unresolvable_on_read_chain',
    "'no_recommendations' would blame the lane for items it actually produced");
  assert.equal(res.metadata.dropped_unidentified_items, undefined,
    'a dropped IDENTIFIED item must not be counted as unidentified');
  assert.equal(res.metadata.price_verification.unresolvable, 1);
});

test('6r. the server.js wiring actually consumes the classifier — the delivery line is pinned', () => {
  // The repo pattern from #1898: mutate the DELIVERY path, not your diff. Reverting only the two
  // wiring lines in server.js would leave every unit test here green while making the whole PR a
  // production no-op, so the consuming lines are pinned at the source level (same pattern as
  // tests/public_feed_gate.node.test.cjs).
  const fs = require('node:fs');
  const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(server, /const classified = classifyVerifyPriceResponse\(response\.status, response\.data\);/,
    'the verifyPrice wiring must classify through the exported function');
  assert.match(server, /if \(classified !== undefined\) return classified;/,
    'the wiring must RETURN the classification — reading it without returning is the no-op mutant');
  assert.match(server, /makeRecommendProducts, classifyVerifyPriceResponse \} = require\('\.\/agentSignals\/recommendProducts'\)/,
    'the classifier must be the exported one, not a local copy that can drift');
});

test('6n. a drop under an enforced ceiling still re-slots from the survivors, never resurrects the dead id', async () => {
  const dead = { ...ITEM_FULL, sku: { product_id: 'sig_dead', name: 'Dead Cheap Pick' }, price: { amount: 10, currency: 'USD' } };
  const pricey = { ...ITEM_FULL, sku: { product_id: 'sig_pricey', name: 'Violator' }, price: { amount: 50, currency: 'USD' } };
  const h = makeRecommendProducts({
    generate: async () => laneResult([dead, pricey, ITEM_FULL]),
    isEnabled: () => true,
    verifyPrice: async ({ product_id }) => (product_id === 'sig_dead' ? { unresolvable: true } : { price: 50, currency: 'USD' }),
  });
  const res = await h({ payload: { need: 'x', constraints: { price_max: 40 } } }, {});
  assert.equal(JSON.stringify(res).includes('sig_dead'), false,
    'a conforming price on a dead id must not out-rank real items — the item does not exist');
  assert.deepEqual(res.signals.map((s) => s.subject.id), ['sig_pricey', 'sig_abc'],
    'the surviving items are slotted by the ceiling rules alone');
  assert.equal(res.metadata.price_verification.unresolvable, 1);
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
  assert.deepEqual(v.watchouts.slice(1), ['Stays below SPF 30 protection on its own', 'Limit use to 2-3 times per week', 'Keep the cap closed']);
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

  // an UNDECLARED argument is refused loudly by the surface's declared-schema guard — it used to be
  // silently dropped by the allowlist, which is how a misplaced top-level price_max became an
  // unenforced budget on prod (2026-08-25)
  await assert.rejects(
    surface.callTool('recommend_products', { need: 'gentle exfoliant', merchant_id: 'dropped' }, { agent_id: 'agent_a' }),
    (e) => e.code === 'INVALID_ARGUMENTS' && e.message.includes('"merchant_id"'),
  );
  assert.equal(seen.length, 0, 'a refused call must never reach the lane');

  const constraints = { budget: 'under $40' };
  const out = await surface.callTool('recommend_products', { need: 'gentle exfoliant', constraints, language: 'EN', limit: 2 }, { agent_id: 'agent_a' });
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

// ---------------------------------------------------------------------------------------------
// 6. OUTCOME-GRAPH JOIN KEYS (recommendation_id / recommendation_set_id)
//
// The card rail cannot measure completion, price delta or failure reason unless an outcome can be
// joined back to the recommendation that produced it. `click_id` is minted at redirect-build time
// and only on the /r?token= path, so an agent that drives checkout from the item's own url is
// unattributable. These pin that the keys exist, are per-item, and survive the real surface.
// ---------------------------------------------------------------------------------------------

test('7a. every returned signal carries a unique recommendation_id, and metadata carries the set id', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL, ITEM_INTERNAL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'gentle exfoliant' } }, {});

  assert.equal(res.signals.length, 2);
  const ids = res.signals.map((s) => s.value.recommendation_id);
  for (const id of ids) assert.match(id, /^rec_[0-9a-f]{24}$/, 'per-item handoff key');
  assert.equal(new Set(ids).size, 2, 'two handoffs must not share one outcome row');
  assert.match(res.metadata.recommendation_set_id, /^rset_[0-9a-f]{24}$/);
});

test('7b. EVERY empty exit is addressable, not just the successful one', async () => {
  // Found by review: the set id was minted at the END, so three of the four empty exits carried no
  // key at all. `lane_unavailable` is the one that matters — it is the only empty class that is a
  // DEFECT rather than a legitimate answer, and this lane has gone dark in prod before. Those are
  // exactly the events an outcome graph needs to count. A table, so a fourth exit added later
  // without a key is a visible omission rather than an untested path.
  const cases = [
    ['disabled', makeRecommendProducts({ generate: async () => laneResult([]), isEnabled: () => false }), { need: 'x' }],
    ['need_required', makeRecommendProducts({ generate: async () => laneResult([]), isEnabled: () => true }), {}],
    ['lane_unavailable', makeRecommendProducts({ generate: async () => { throw new Error('AURORA_NOT_CONFIGURED'); }, isEnabled: () => true }), { need: 'x' }],
    [null, makeRecommendProducts({ generate: async () => laneResult([]), isEnabled: () => true }), { need: 'no answer' }],
  ];
  for (const [reason, handler, payload] of cases) {
    const res = await handler({ payload }, {});
    assert.deepEqual(res.signals, [], `${reason || 'empty_ok'}: no signals`);
    assert.equal(res.metadata.reason ?? null, reason, `${reason || 'empty_ok'}: reason`);
    assert.match(res.metadata.recommendation_set_id, /^rset_[0-9a-f]{24}$/,
      `${reason || 'empty_ok'}: an unrecordable outage is an outage the outcome graph cannot count`);
  }
});

test('7c. the id survives the price-violation marker pass, which mutates value in place', async () => {
  // markPriceViolation rewrites why/notes/watchouts/fit on s.value. Stamping the id after that pass
  // is what guarantees it cannot be dropped the way a budget marker was in #2070.
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_OVERPRICED]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', constraints: { price_max: 40 } } }, {});

  assert.equal(res.signals.length, 1);
  assert.ok(Array.isArray(res.signals[0].value.constraint_violations), 'the marker pass did run');
  assert.match(res.signals[0].value.recommendation_id, /^rec_[0-9a-f]{24}$/);
});

test('7d. the join keys survive the REAL commerce surface and its sanitizer', async () => {
  // Same reasoning as 4i: a key DENYLIST is what lets these through today, so pin them — a future
  // denylist entry must not be able to strip the outcome-graph join key and leave a green suite.
  const { createCommerceToolSurface } = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const executor = {
    async execute(op, params, ctx) {
      const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL]), isEnabled: () => true });
      return h(params, ctx);
    },
  };
  const surface = createCommerceToolSurface(executor, { cache: false });
  const out = await surface.callTool('recommend_products', { need: 'gentle exfoliant' }, { agent_id: 'agent_a' });
  const body = typeof out === 'string' ? JSON.parse(out) : (out?.content?.[0]?.text ? JSON.parse(out.content[0].text) : out);

  assert.match(body.signals[0].value.recommendation_id, /^rec_[0-9a-f]{24}$/);
  assert.match(body.metadata.recommendation_set_id, /^rset_[0-9a-f]{24}$/);
});

test('7e. the rec_ prefix is what keeps a join key out of the PAN redactor', async () => {
  // resultSanitizer treats any key ending in "id" as an id key, but `recommendationid` is NOT in its
  // PAN_EXEMPT_ID_KEYS set — so the VALUE is still Luhn-gated PAN-scanned. A random hex body that
  // came up all-digits and passed Luhn would be silently rewritten to [REDACTED_PAN], corrupting the
  // join key for one recommendation in a few million.
  //
  // This forces that corner: the id body is a real Luhn-valid test PAN. It survives ONLY because
  // PAN_RE starts with \b and `_` is a word character, so the digit run cannot begin a match. Delete
  // the `rec_` prefix and this test fails — which is the point of writing it.
  const LUHN_VALID_ALL_DIGITS = '4111111111111111';
  const { createCommerceToolSurface } = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const executor = {
    async execute(op, params, ctx) {
      const h = makeRecommendProducts({
        generate: async () => laneResult([ITEM_FULL]),
        isEnabled: () => true,
        newId: () => LUHN_VALID_ALL_DIGITS,
      });
      return h(params, ctx);
    },
  };
  const surface = createCommerceToolSurface(executor, { cache: false });
  const out = await surface.callTool('recommend_products', { need: 'gentle exfoliant' }, { agent_id: 'agent_a' });
  const body = typeof out === 'string' ? JSON.parse(out) : (out?.content?.[0]?.text ? JSON.parse(out.content[0].text) : out);

  // ORDER MATTERS. The redaction assertions come FIRST so that deleting the prefix fails this test
  // for the REASON the test exists, not merely because a format regex stopped matching — otherwise
  // the failure message sends the next reader chasing the wrong thing.
  assert.ok(!JSON.stringify(body).includes('REDACTED_PAN'),
    'a Luhn-valid id body must not reach the PAN redactor — the id prefix is what prevents it');
  assert.ok(String(body.signals[0].value.recommendation_id).includes(LUHN_VALID_ALL_DIGITS),
    'the id body must survive verbatim');
  assert.ok(String(body.metadata.recommendation_set_id).includes(LUHN_VALID_ALL_DIGITS),
    'the set id body must survive verbatim');
  assert.equal(body.signals[0].value.recommendation_id, `rec_${LUHN_VALID_ALL_DIGITS}`);
  assert.equal(body.metadata.recommendation_set_id, `rset_${LUHN_VALID_ALL_DIGITS}`);
});


test('7f. the marker passes mutate value IN PLACE — the invariant "stamp last" depends on', () => {
  // Review found that moving the mint earlier left all tests green, i.e. the PR's own headline
  // ordering claim had no protection. Ordering is only load-bearing because both marker passes
  // mutate `signal.value` rather than rebuilding it; the day one of them becomes
  // `signal.value = { ...v, ... }`, a field stamped BEFORE it is silently dropped — the #2070
  // failure. That object identity is the thing that can actually break, so pin it directly.
  const ceiling = { limit: 40, currency: 'USD' };
  for (const [name, mark] of [['markPriceViolation', markPriceViolation], ['markPriceUnverifiable', markPriceUnverifiable]]) {
    const signal = recommendationItemToSignal(ITEM_OVERPRICED, {});
    const before = signal.value;
    before.__identity_probe = 'sentinel';
    const out = mark(signal, ceiling);
    assert.equal(out.value, before, `${name} must not rebuild signal.value`);
    assert.equal(out.value.__identity_probe, 'sentinel',
      `${name} dropped a field stamped before it — anything minted earlier is unsafe`);
  }
});

test('7g. a lane outage is JOINABLE — the set id reaches the log, not just the response', async () => {
  // Round-2 review of #2080: minting the set id before the guards made every response
  // addressable, but on `lane_unavailable` there are zero items, so the agent has no outcome
  // to report and nothing server-side recorded the id — every outage still landed in one
  // unjoinable bucket. The response half without the log half does not close that gap.
  const warnings = [];
  const h = makeRecommendProducts({
    generate: async () => { throw new Error('AURORA_NOT_CONFIGURED'); },
    isEnabled: () => true,
    logger: { warn: (fields, msg) => warnings.push({ fields, msg }) },
  });

  const res = await h({ payload: { need: 'anything' } }, {});

  assert.equal(res.metadata.reason, 'lane_unavailable');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, 'recommend_products lane failed');
  assert.equal(
    warnings[0].fields.recommendation_set_id,
    res.metadata.recommendation_set_id,
    'the logged id must be the SAME one the caller received, or the join is fiction',
  );
  assert.match(warnings[0].fields.recommendation_set_id, /^rset_[0-9a-f]{24}$/);
});


// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 8. THE CONTRACT THE TOOL DESCRIPTION MAKES. Both halves of this sentence were false in production on
// 2026-09-08, verified against commerce.mcp.pivota.cc:
//
//   "Today's lane is tuned for beauty/skincare: off-vertical needs answer with an empty shortlist and
//    a reason, never with fabricated products."
//
// The live call — need: "I collect Pokémon trading cards and want a sealed Scarlet & Violet booster
// box for my collection", limit 5 — returned a Jurlique cleanser and a COSRX moisturizer at
// `fit.level: 'high'`, plus a "Daily Broad Spectrum SPF 30 Sunscreen" whose product_id, merchant_id,
// brand, price, currency, url and image_url were ALL null. `products_empty_reason` was null and no
// warning mentioned the vertical. Note the response already carried `ungrounded_returned: 1` — the
// condition was detected and then not acted on, which is why these pins assert on the RETURNED
// SIGNALS and not on a counter.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

test('8a. the live 2026-09-08 repro: an off-vertical need is empty and reasoned, and never reaches the lane', async () => {
  let laneCalls = 0;
  const infos = [];
  const h = makeRecommendProducts({
    // If the gate ever stops firing, the lane answers with beauty products and this fixture makes the
    // failure LOUD rather than merely returning a different empty.
    generate: async () => { laneCalls += 1; return laneResult([ITEM_FULL]); },
    isEnabled: () => true,
    logger: { info: (o, m) => infos.push([o, m]) },
  });
  const res = await h({ payload: {
    need: 'I collect Pokémon trading cards and want a sealed Scarlet & Violet booster box for my collection',
    limit: 5,
  } }, { agent_id: 'agent_a' });

  assert.deepEqual(res.signals, [], 'an off-vertical need answers with an EMPTY shortlist');
  assert.equal(res.metadata.products_empty_reason, 'off_vertical', 'and with a REASON — it was null in prod');
  assert.equal(res.metadata.returned, 0);
  assert.equal(res.metadata.vertical, 'beauty');
  assert.equal(res.metadata.off_vertical_marker, 'Pokémon');
  assert.equal(laneCalls, 0, 'the lane is never called: no LLM generation, and nothing to fabricate from');
  assert.equal(res.metadata.off_vertical_detected_by, 'need_lexicon');
  // the refusal is joinable: an unlogged gate cannot be audited for the false positives that cost sales
  assert.equal(infos.length, 1);
  assert.match(infos[0][1], /off-vertical/);
  assert.equal(infos[0][0].marker, 'Pokémon');
  assert.equal(infos[0][0].detected_by, 'need_lexicon');
  assert.equal(infos[0][0].recommendation_set_id, res.metadata.recommendation_set_id);
  // The refusal is an ANSWER, not a failure — it must not wear the shape the outage exits use, or a
  // partner cannot tell "we cannot help with this" from "we broke".
  assert.equal(res.metadata.reason, undefined);
  assert.equal(typeof res.metadata.recommendation_set_id, 'string', 'still an addressable event');
  assert.equal(res.metadata.missing_info[0],
    'This recommendation lane covers skincare and beauty only; it cannot serve this need.',
    'missing_info says what would be needed');
  // The CN refusal is a first-class output of this tool (`language: 'CN'`) and was pinned by nothing.
  const resCn = await h({ payload: { need: 'a graphics card', language: 'CN' } }, { agent_id: 'agent_a' });
  assert.equal(resCn.metadata.products_empty_reason, 'off_vertical');
  assert.equal(resCn.metadata.missing_info[0], '该推荐通道仅覆盖护肤/美妆品类，无法回答此需求。');
  assert.match(resCn.metadata.warnings[0], /非美妆品类/);
  assert.ok(/off-vertical/i.test(res.metadata.warnings[0]), 'the vertical mismatch is warned about explicitly');
});

test('8b. the gate is asymmetric: it refuses only needs that name NO beauty at all', async () => {
  // OFF — named domains, nothing beauty
  for (const need of [
    'a sealed booster box for my collection',
    'best headphones under 200',
    'a gaming laptop for my son',
    'dog food for a senior labrador',
    'a new mattress, king size',
    '我想买一张显卡',
  ]) assert.ok(offVerticalMarker(need), `"${need}" is off-vertical`);

  // IN — a false positive here refuses a paying buyer, the only error direction that costs a sale.
  for (const need of [
    'a gentle retinol for beginners under $40',
    'a lipstick to match my dress',          // apparel word, but clearly beauty
    'a moisturizer that works under makeup',
    'sunscreen for a hiking trip',
    'something for my dark spots',
    'a hair dryer that will not fry my ends',
    'carbon filter tips for my car ride skincare kit',
    '敏感肌的防晒推荐',
  ]) assert.equal(offVerticalMarker(need), null, `"${need}" must keep its shortlist`);

  // The suppression is what makes it asymmetric: the SAME off-vertical word passes once beauty is named.
  assert.ok(offVerticalMarker('a booster box'));
  assert.equal(offVerticalMarker('a booster box of sheet masks'), null,
    'a beauty word anywhere suppresses the gate — false negatives are the cheap direction');
});

test('8c. NO returned signal ever carries a null product_id — by either route into one', async () => {
  // Route 1: the lane's ungrounded archetype (the prod defect: every identity field null).
  const phantom = {
    name: 'Daily Broad Spectrum SPF 30 Sunscreen',
    grounding_status: 'ungrounded',
    score: 88,
    reasons: ['Broad spectrum protection for daily use'],
  };
  // Route 2: NO grounding_status at all — absence reads as GROUNDED in the projector, so this item
  // claims `grounding: 'catalog'` while carrying no id. Filtering on grounding alone leaves it open,
  // which is exactly why the id is checked on its own terms.
  const namedNoId = { name: 'A product with a name and no id', score: 91, reasons: ['unresolved'] };

  const warns = [];
  const h = makeRecommendProducts({
    generate: async () => laneResult([phantom, namedNoId, ITEM_FULL]),
    isEnabled: () => true,
    logger: { warn: (o, m) => warns.push([o, m]) },
  });
  const res = await h({ payload: { need: 'a daily sunscreen', limit: 10 } }, { agent_id: 'agent_a' });

  // THE INVARIANT, asserted over whatever came back rather than over a fixed length: this must hold
  // for every shortlist this function can produce, not just this fixture's.
  for (const sig of res.signals) {
    assert.equal(typeof sig.value.product.product_id, 'string');
    assert.ok(sig.value.product.product_id.length > 0, 'a null/empty product_id must never reach a caller');
    assert.equal(sig.subject.id, sig.value.product.product_id);
    assert.equal(sig.value.grounding, 'catalog');
    assert.equal(sig.evidence.method, 'llm_recommendation_catalog_grounded',
      "'llm_recommendation' is the ungrounded method — it must not appear on a returned signal");
  }
  assert.deepEqual(res.signals.map((x) => x.value.product.product_id), ['sig_abc']);
  assert.equal(res.metadata.ungrounded_suppressed, 1);
  assert.equal(res.metadata.unidentified_suppressed, 1);
  // BOTH names land here, not just the ungrounded one. From a caller's side these are one thing —
  // "a product the lane named but could not resolve" — and the description says they appear here.
  // Counting the id-less one and dropping its name left a named product vanishing behind an integer.
  assert.deepEqual(res.metadata.unresolved_archetypes,
    ['Daily Broad Spectrum SPF 30 Sunscreen', 'A product with a name and no id']);
  // The id-less GROUNDED item is a lane defect, not a policy outcome, so it is logged rather than
  // only counted — a silent suppression is how this class of thing survives unnoticed for a month.
  assert.equal(warns.length, 1);
  assert.match(warns[0][1], /no product_id/);
  assert.equal(warns[0][0].count, 1);

  // and the archetype, which IS the only useful part, survives as TEXT and never as a product node
  assert.equal(typeof res.metadata.unresolved_archetypes[0], 'string');
});

test('8d. an ungrounded item that DOES carry an id is still suppressed — the contract is grounding, not just identity', async () => {
  // The two rules are independent. An "ungrounded" row carrying a stale id must not slip through on
  // the strength of the id alone: the description promises no FABRICATED products, and the lane has
  // told us it could not resolve this one.
  const idBearingPhantom = {
    name: 'Invented but id-bearing',
    grounding_status: 'ungrounded',
    sku: { product_id: 'sig_phantom' },
    reasons: ['x'],
  };
  const h = makeRecommendProducts({ generate: async () => laneResult([idBearingPhantom, ITEM_FULL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'a serum', limit: 10 } }, { agent_id: 'agent_a' });
  assert.deepEqual(res.signals.map((x) => x.value.product.product_id), ['sig_abc']);
  assert.equal(res.metadata.ungrounded_suppressed, 1);
});

test('8e. the tool description and the code agree — the promises are quoted from the served text', async () => {
  // The description is what a partner agent actually plans against. Each assertion below pins one
  // claim the served text makes — the two the 2026-09-08 response contradicted outright, plus the
  // limits later review forced into the open (the off-vertical hedge, what the band measures, the
  // lane's narrower skincare domain). If someone re-broadens a promise, it fails here rather than in a
  // partner's product.
  const surfaceMod = await import(pathToFileURL(path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js')).href);
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'mcp-server', 'src', 'commerceToolSurface.js'), 'utf8');
  assert.ok(src.includes("products_empty_reason: 'off_vertical'"),
    'the description must name the reason code the code actually emits');
  assert.ok(/never returned as items/.test(src),
    'the description must say unresolved products are not returned, since they are not');
  assert.ok(!/never with fabricated products\./.test(src),
    'the old wording promised something the response shape could not express — it must not come back');
  // THE HEDGE IS LOAD-BEARING. Off-vertical detection is a keyword list plus the lane's own
  // admission; neither is exhaustive, and measured 2026-09-08 "an air fryer" and "a treadmill" reached
  // the real door and came back with beauty products. A description promising the universal would be
  // the same false-description defect this PR exists to fix, one level up — so the unconditional claim
  // must NOT return, and the caveat must stay.
  assert.ok(/best-effort, not exhaustive/.test(src) && /RECOGNISED off-vertical/.test(src),
    'the off-vertical promise must stay hedged to what the detection can actually honour');
  assert.ok(!/an off-vertical need answers with an empty shortlist and `metadata/.test(src),
    'the unhedged universal must not come back');
  // The id guarantee, by contrast, IS unconditional — it is enforced on every exit, so it is stated flatly.
  assert.ok(/Every returned item IS a catalog product with a non-null `product_id`/.test(src));
  // `fit` bands the LANE's score with no reference to the need (recommendationItemToSignal), so a
  // gate-passing off-vertical need still reads fit 'high'. Unfixed here, but it must not be unsaid.
  assert.ok(/`fit` is the lane's own confidence in the item, NOT a measure of how well it answers your need/.test(src),
    'the description must not let fit be read as agreement with the need');
  // The lane's prompt is SKINCARE-only while the tool advertises beauty/skincare — a makeup need comes
  // back with skincare picks. Narrower than advertised is still a description that must say so.
  assert.ok(/never to recommend makeup, brushes, beauty tools, devices, fragrance, haircare or supplements/.test(src),
    "the lane's real (narrower) domain must be stated, since it changes what a makeup need gets back");
  assert.ok(surfaceMod, 'the surface module still loads with the edited description');
});


test('8f. separators cannot buy a fabricated shortlist — the repro one hyphen away still refuses', async () => {
  // Every multi-word alternative is written with a single space, so before normalisation these ALL
  // passed the gate while their spaced spellings were refused: the reported need, reworded.
  for (const need of ['a booster-box', 'trading-cards', 'a graphics-card', 'magic: the gathering cards', 'an air-fryer'])
    assert.ok(offVerticalMarker(need), `"${need}" must refuse exactly like its spaced spelling`);
  // and the spaced spellings still do
  for (const need of ['a sealed Scarlet & Violet booster box', 'trading cards', 'a graphics card'])
    assert.ok(offVerticalMarker(need));

  // WHAT THE WORD ANCHORS ACTUALLY CARRY. An earlier comment claimed they stop "carbon" being read as
  // "car"; they do not, because `car` is not an alternative (only the two-word `car tires` is). This
  // is the real case: a token must not match inside a longer word.
  assert.ok(offVerticalMarker('tcg singles'), 'the bare token matches');
  assert.equal(offVerticalMarker('tcgel gets everywhere'), null, 'but never inside a longer word (trailing \\b)');
  assert.equal(offVerticalMarker('the wtcg deck'), null, 'nor at the end of one (leading \\b)');
  assert.equal(offVerticalMarker('carbon filter'), null);
});

test('8g. the lane admitting it was off-DOMAIN never empties the shortlist — its domain is narrower than ours', async () => {
  // A REMOVED AXIS, pinned so it cannot come back. The lane admits in its own warnings when it declines
  // a need ("Non-skincare requests … have been excluded per domain boundaries"), which looked like free
  // coverage for needs no keyword list holds. It is not: prompts/reco_main_v1_2.system.txt bounds the
  // lane to "skincare only … never makeup, brushes, beauty tools, devices, fragrance, haircare, or
  // supplements" — NARROWER than the beauty/skincare this tool advertises. So it emits that same
  // sentence for a bronzer or a brush set, and acting on it emptied the shortlist for in-vertical
  // buyers while telling them their beauty need was not beauty.
  for (const [need, warning] of [
    ['a bronzer for contouring', 'Makeup items such as bronzer fall outside the skincare domain; returning skincare picks instead.'],
    ['a brush set for my kit', 'Beauty tools are outside the scope of this lane.'],
    ['cologne for my dad', 'Fragrance is outside the skincare domain.'],
    ['what helps with razor burn', 'Consult a dermatologist; prescription options fall outside the scope of this routine.'],
    ['something for my kitchen counter', 'Non-skincare requests (such as kitchen appliances) have been excluded per domain boundaries.'],
  ]) {
    const h = makeRecommendProducts({
      generate: async () => laneResult([ITEM_FULL], { warnings: [warning] }),
      isEnabled: () => true,
    });
    const res = await h({ payload: { need } }, { agent_id: 'agent_a' });
    assert.equal(res.signals.length, 1, `"${warning}" must be relayed, never acted on`);
    assert.equal(res.metadata.products_empty_reason, null);
    assert.equal(res.metadata.off_vertical_detected_by, undefined);
    assert.deepEqual(res.metadata.warnings, [warning], "the lane's own words reach the caller intact");
  }
});

test('8h. the class the LANE refuses but this TOOL advertises is never refused by the gate', async () => {
  // The lane's prompt excludes makeup, tools, fragrance, haircare and supplements; the tool advertises
  // beauty/skincare. Every one of these was measured carrying NO beauty token, so they sat one lexicon
  // entry away from being refused as off-vertical. They are beauty buyers and must keep their shortlist.
  // STRONG evidence: an unambiguous beauty word, which outranks even a HARD off-vertical domain.
  const strongEvidence = [
    'a bronzer for contouring', 'a highlighter stick', 'setting spray',
    'false lashes for a wedding', 'an eyelash curler', 'a gel manicure kit', 'cologne for my dad',
    'body butter', 'a gua sha tool', 'melasma treatment', 'under-eye bags', 'razor burn',
    'an eyeshadow palette', 'a brow pencil', 'a blender sponge', 'a makeup brush set',
  ];
  // WEAK evidence: an ambiguous noun (`brush`, `nails`, `palette`…). Served on its own, and enough to
  // hold a SOFT domain, but deliberately NOT enough to outrank a HARD one — "a sponge for my
  // dishwasher" is the same shape and must refuse.
  const weakEvidence = ['a brush set for my kit', 'a top coat for my nails', 'a compact palette'];
  for (const need of [...strongEvidence, ...weakEvidence])
    assert.equal(offVerticalMarker(need), null, `"${need}" is in-vertical for this tool and must not be refused`);

  // THE ASSERTION ABOVE CANNOT FAIL ON ITS OWN, and that is worth saying out loud: these needs carry no
  // off-vertical token either, so they return null whether or not the beauty side knows the word —
  // deleting the entire makeup/tool/fragrance vocabulary left every line above green. The suppression
  // only does work when an off-vertical token is ALSO present, so that is the shape it must be pinned
  // in: each need is probed with a known off-vertical word appended, where only a beauty token can
  // still win. This is what makes the vocabulary load-bearing rather than decorative.
  // THE PROBE TIER MUST MATCH THE EVIDENCE TIER, or the test asserts the wrong rule: strong evidence
  // is probed against a HARD domain, weak evidence against a SOFT one.
  for (const need of strongEvidence)
    assert.equal(offVerticalMarker(`${need} laptop`), null,
      `"${need}" must carry a beauty token strong enough to suppress a HARD off-vertical word`);
  for (const need of weakEvidence) {
    assert.equal(offVerticalMarker(`${need} sneakers`), null,
      `"${need}" must carry enough beauty to hold a SOFT off-vertical word`);
    assert.ok(offVerticalMarker(`${need} dishwasher`),
      `"${need}" is ambiguous and must NOT outrank a HARD one — that is the dishwasher-sponge shape`);
  }

  // controls: both probe words refuse on their own, so neither probe is vacuous
  assert.ok(offVerticalMarker('a widget laptop'));
  assert.ok(offVerticalMarker('a widget sneakers'));

  // MIXED AND INCIDENTAL NEEDS — the direction that loses a sale, and the one this file's doctrine
  // names as the expensive one. All of these were SERVED on main and REFUSED by the first version of
  // the qualification fix, which measured itself only against needs containing no off-vertical word
  // and so could not see it. Two shapes: a bag or garment the cosmetic is carried in / worn with
  // (SOFT), and a genuinely mixed basket (STRONG beauty word alongside a HARD domain).
  for (const need of [
    'a brush that fits in my handbag',
    'a travel palette for my backpack',
    'a highlighter small enough for my handbag',
    'a sponge I can keep in my backpack',
    'a compact palette for my carry on backpack',
    'nails that will not chip while I wear sneakers all day',
    'a stippling brush, and diapers while I am here',
    'a duo fibre brush and a treadmill',
  ]) assert.equal(offVerticalMarker(need), null, `"${need}" is a beauty buyer and must keep the shortlist`);

  // and the SOFT words still refuse on their own, or the tier would be doing nothing
  for (const need of ['running shoes', 'a winter coat', 'a handbag', 'sneakers'])
    assert.ok(offVerticalMarker(need), `"${need}" alone names no beauty and must refuse`);
});

test('8i. the categories measured live on 2026-09-08 are refused now', async () => {
  // Every one of these reached the real door and came back with the beauty shortlist at fit 'high'.
  // The list is not exhaustive and the description no longer claims it is — but a measured miss that
  // stays missing is just an unfixed bug.
  for (const need of ['a new iPhone', 'an air fryer', 'a treadmill', 'diapers', 'running shoes',
    'a winter coat', 'a rifle scope', 'car wax', 'protein powder'])
    assert.ok(offVerticalMarker(need), `"${need}" was measured passing the gate — it must refuse now`);

  // and none of them cost a beauty buyer their shortlist. PROBED, not asserted bare: these needs carry
  // no off-vertical token either, so a plain `=== null` here passes even with the beauty side deleted —
  // the same shape that made 8h green while pinning nothing. Appending an explicit off-vertical word
  // means only a beauty token can still win.
  for (const need of ['a beauty blender sponge', 'a foundation brush',
    'wax strips for upper lip hair', 'a setting powder for oily skin', 'a body wash for eczema']) {
    assert.equal(offVerticalMarker(need), null, `"${need}" is beauty and must keep its shortlist`);
    assert.equal(offVerticalMarker(`${need} treadmill`), null,
      `"${need}" must carry a beauty token strong enough to suppress a HARD off-vertical word`);
  }
  // weak evidence: served, and held against a SOFT domain, but not against a HARD one (see 8h)
  assert.equal(offVerticalMarker('a top coat for my nails'), null);
  assert.equal(offVerticalMarker('a top coat for my nails sneakers'), null);
  assert.ok(offVerticalMarker('a widget treadmill'), 'control: the probe word does refuse on its own');
});

test('8j. an ambiguous beauty word never cancels an explicit off-vertical signal', async () => {
  // THE FIX-FORWARD DEFECT from #2149. `brush`, `sponge`, `nail`, `palette` and `highlighter` went onto
  // the suppression side BARE, and they are ordinary English before they are beauty words — so every
  // one of them cancelled an unambiguous off-vertical need. Measured on the merged commit: 40/40 of
  // these refused correctly BEFORE the widening and 0/40 after it. The suppression side is the cheap
  // direction to be liberal in, but not with words the rest of commerce also owns.
  const ambiguous = ['sponge', 'brush', 'nails', 'palette', 'highlighter'];
  const offVertical = ['dishwasher', 'chainsaw', 'textbooks', 'laptop', 'treadmill', 'air fryer', 'mattress', 'dog food'];
  for (const w of ambiguous)
    for (const o of offVertical)
      assert.ok(offVerticalMarker(`a ${w} for my ${o}`),
        `"${w}" must not cancel "${o}" — a bare beauty word is not a beauty need`);

  // The QUALIFIED spellings are the ones that carry beauty, and they still win outright.
  for (const need of ['a makeup brush', 'a blending sponge', 'nail polish', 'an eyeshadow palette',
    'a highlighter stick', 'a beauty blender sponge', 'gel nails'])
    assert.equal(offVerticalMarker(`${need} laptop`), null,
      `"${need}" names its beauty context and must still suppress`);

  // AND THE QUALIFIERS THEMSELVES MUST NOT BE AMBIGUOUS — the same defect one level in. Each of these
  // was a qualifier the previous revision accepted, and each moved the leak rather than closing it: a
  // wire brush SET, a silicone SPONGE, a COLOUR palette, a highlighter PEN, a nail CLIPPER and "MY
  // nail gun" are hardware, stationery and pet-grooming phrases. A qualifier the rest of commerce also
  // uses is not a qualifier.
  for (const need of ['a wire brush set for my chainsaw', 'a brush kit for my lawn mower',
    'a silicone sponge for my dishwasher', 'my nail gun and a power drill',
    'a color palette for my laptop', 'a colour palette for my graphics card',
    'an eye palette for my webcam', 'a highlighter pen for my textbooks',
    'dog food and a nail clipper for my dog', 'a blender for smoothies', 'a kitchen blender'])
    assert.ok(offVerticalMarker(need), `"${need}" is not a beauty need — its qualifier is borrowed`);
});

test('8l. the archetype list is not bounded by `limit` — it is built from every lane row', async () => {
  // The cap was raised from 8 on the stated grounds that a lane response cannot exceed `limit`. It
  // can: `unresolvedArchetypes` is built in the suppression loop over EVERY projected row, and
  // `.slice(0, limit)` runs later and only on survivors. Driven, because the justification was wrong
  // even though the change was right.
  const rows = Array.from({ length: 12 }, (_, i) => ({ name: `Archetype ${i + 1}`, grounding_status: 'ungrounded', reasons: ['x'] }));
  const h = makeRecommendProducts({ generate: async () => laneResult(rows), isEnabled: () => true });
  const res = await h({ payload: { need: 'a serum', limit: 3 } }, {});
  assert.equal(res.metadata.ungrounded_suppressed, 12);
  assert.equal(res.metadata.unresolved_archetypes.length, 12,
    'twelve suppressed rows produce twelve names, and `limit: 3` does not truncate them');
  assert.equal(res.metadata.products_empty_reason, 'no_grounded_recommendations');
});

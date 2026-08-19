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
//  5. through createCommerceToolSurface: the tool is listed with the strict schema, toParams keeps need /
//     constraints / language / limit (and clones constraints), and the SANITIZER keeps why/fit/grounding/
//     confidence_overall while the projector never places a bare `confidence`/`score` on a product node

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { makeRecommendProducts, recommendationItemToSignal, normalizeConstraints, agentLaneUid } = require('../src/agentSignals/recommendProducts');

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

const ITEM_FULL = {
  sku: { product_id: 'sig_abc', merchant_id: 'merch_1', brand: 'Paula\'s Choice', display_name: '2% BHA Liquid Exfoliant', category: 'Exfoliant', price: 35, currency: 'USD' },
  pdp_open: { directUrl: 'https://shop.example/p/sig_abc', canonicalProductRef: { product_id: 'sig_abc', merchant_id: 'merch_1' } },
  why_candidate: { summary: 'Leave-on BHA clears pores without scrubbing', reasons_user_visible: ['fragrance-free', 'well tolerated by sensitive skin'] },
  watchouts: ['start 2-3x/week'],
  step: 'treatment',
  confidence: 0.9, // a bare confidence on a product-shaped item — must NOT be copied onto the signal's product node
  score_breakdown: { relevance: 0.8 },
};
const ITEM_UNGROUNDED = { name: 'Some product the lane named but could not resolve', grounding_status: 'ungrounded', why_candidate: ['cheap'] };
const ITEM_EMPTY = { why_candidate: ['no identity at all'] };

test('1. dark flag and missing need never reach the lane', async () => {
  let calls = 0;
  const off = makeRecommendProducts({ generate: async () => { calls += 1; return laneResult([ITEM_FULL]); }, isEnabled: () => false });
  const dark = await off({ payload: { need: 'gentle exfoliant' } }, { agent_id: 'agent_a' });
  assert.deepEqual(dark, { subject: { kind: 'need', id: 'gentle exfoliant' }, signals: [], metadata: { reason: 'disabled' } });
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
});

test('3. projection: identity, why, watchouts, grounding; no-identity items dropped; limit honoured; metadata', async () => {
  const h = makeRecommendProducts({ generate: async () => laneResult([ITEM_FULL, ITEM_EMPTY, ITEM_UNGROUNDED, ITEM_FULL]), isEnabled: () => true });
  const res = await h({ payload: { need: 'exfoliant', limit: 2 } }, { agent_id: 'agent_a' });
  assert.equal(res.signals.length, 2);
  const s = res.signals[0];
  assert.equal(s.signal_type, 'recommendation');
  assert.deepEqual(s.subject, { kind: 'product', id: 'sig_abc' });
  assert.equal(s.value.rank, 1);
  assert.equal(s.value.product.product_id, 'sig_abc');
  assert.equal(s.value.product.merchant_id, 'merch_1');
  assert.equal(s.value.product.title, '2% BHA Liquid Exfoliant');
  assert.equal(s.value.product.price, 35);
  assert.equal(s.value.product.currency, 'USD');
  assert.equal(s.value.product.url, 'https://shop.example/p/sig_abc');
  assert.deepEqual(s.value.why, ['Leave-on BHA clears pores without scrubbing', 'fragrance-free', 'well tolerated by sensitive skin']);
  assert.deepEqual(s.value.watchouts, ['start 2-3x/week']);
  assert.equal(s.value.routine_step, 'treatment');
  assert.equal(s.value.grounding, 'catalog');
  assert.equal(s.evidence.method, 'llm_recommendation_catalog_grounded');
  // the projector never copies a bare confidence/score onto a product node
  assert.equal(s.value.product.confidence, undefined);
  assert.equal(s.confidence, undefined);
  assert.equal(JSON.stringify(s).includes('score_breakdown'), false);
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

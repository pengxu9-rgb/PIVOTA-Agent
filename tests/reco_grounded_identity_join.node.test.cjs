'use strict';
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const { __internal } = require('../src/auroraBff/routes');
const { makeRecommendProducts, recommendationItemToSignal, offVerticalMarker } = require('../src/agentSignals/recommendProducts');
const { recommendationIdentityConflict } = require('../src/shared/recoProductIdentity');

const CASES = [
  {
    oldId: 'sig_76667b0e7aafd3acb27d2cac02b11d1e', oldName: 'Clarity Cleanser',
    id: 'sig_5194d3f21508bcb274d1b2b0b0e9ac3c', name: 'Glow Mud Cleanser',
    category: 'cleanser', brand: 'PIXI BEAUTY', oldClaim: 'Clarity formula: salicylic acid and probiotics',
    description: 'Glow Mud Cleanser contains 5% glycolic acid.',
  },
  {
    oldId: 'sig_ba2ff7c8f29d5297ba3987cff62542e9', oldName: 'Cheeks Out Freestyle Cream Bronzer — Amber',
    id: 'sig_cf8a781aac4835b95a8f5e5170a6e41f', name: 'Match Stix Contour Skinstick — Caviar',
    category: 'bronzer', brand: 'FENTY BEAUTY', oldClaim: 'Amber cream bronzer formula and shade evidence',
    description: 'Caviar is a contour skinstick.',
  },
];
const url = (id) => `https://agent.pivota.cc/products/${id}`;
function candidate(c, extra = {}) {
  return { product_id: c.id, merchant_id: 'external_seed', name: c.name, brand: c.brand,
    category: c.category, description: c.description, url: url(c.id), price: { amount: 18, currency: 'USD' }, ...extra };
}
function plan(c) {
  return { product_id: c.oldId, merchant_id: 'external_seed', name: c.oldName, step: c.category,
    slot: 'am', product_type: c.category, score: 96, url: url(c.oldId), product_url: url(c.oldId),
    pdp_url: url(c.oldId), canonical_pdp_url: url(c.oldId), image_url: 'https://images.test/old.jpg',
    pdp_open: { external: { url: url(c.oldId) } },
    subject: { kind: 'product', id: c.oldId, product_group_id: 'old-group' },
    product: { product_id: c.oldId, description: c.oldClaim },
    product_intel: { product_id: c.oldId, description: c.oldClaim },
    pivota_insights: { what_it_is: c.oldClaim }, search_card: { description: c.oldClaim },
    shopping_card: { intro: c.oldClaim }, metadata: { evidence: c.oldClaim },
    notes: [c.oldClaim], reasons: [c.oldClaim], warnings: [c.oldClaim], use_case: c.oldClaim,
    concern_match: [c.oldClaim], skin_fit: [c.oldClaim], constraint_notes: [c.oldClaim],
    ingredient_tokens: ['old-formula-token'], unknown_future_evidence: c.oldClaim };
}
const bridge = (items, verifyPrice) => makeRecommendProducts({ isEnabled: () => true,
  generate: async () => ({ norm: { payload: { recommendations: items } } }), verifyPrice });

for (const c of CASES) {
  test(`grounding ${c.oldName} onto ${c.name} binds all identity and evidence to the candidate`, async () => {
    const original = plan(c);
    const snapshot = JSON.stringify(original);
    const merged = __internal.mergeRecoPlanWithGroundedCandidate(original, candidate(c));
    const row = __internal.coerceRecoItemForUi(merged, { lang: 'EN' });
    const response = await bridge([row], async () => ({ price: 18, currency: 'USD' }))({ need: `a ${c.category}` });
    assert.equal(response.signals.length, 1);
    const actual = response.signals[0].value;
    assert.equal(actual.product.product_id, c.id);
    assert.equal(actual.product.title, c.name);
    assert.equal(actual.product.url, url(c.id));
    assert.equal(actual.product.price_verified, true);
    assert.equal(actual.lane_confidence.level, null, 'the old product score cannot vouch for its replacement');
    const rendered = JSON.stringify({ merged, row, response });
    for (const stale of [c.oldId, c.oldClaim, 'old-group', 'old-formula-token', 'old.jpg']) {
      assert.ok(!rendered.includes(stale), `old identity/evidence survived: ${stale}`);
    }
    assert.ok(rendered.includes(c.description), 'correct candidate evidence was preserved');
    assert.equal(merged.slot, 'am');
    assert.equal(merged.step, c.category);
    assert.equal(JSON.stringify(original), snapshot, 'join does not mutate its source');
  });

  test(`unrepaired ${c.name}/${c.oldName} conflict is withheld before price verification`, async () => {
    let checked = 0;
    const conflicting = { ...candidate(c), sku: candidate(c), notes: [c.oldClaim],
      pdp_open: { external: { url: url(c.oldId) } }, grounding_status: 'grounded' };
    assert.equal(recommendationItemToSignal(conflicting), null);
    const response = await bridge([conflicting], async () => { checked++; return { price: 18, currency: 'USD' }; })({ need: `a ${c.category}` });
    assert.equal(checked, 0);
    assert.deepEqual(response.signals, []);
    assert.equal(response.metadata.identity_mismatch_suppressed, 1);
    assert.equal(response.metadata.dropped_unidentified_items, undefined, 'an identity conflict is not a missing ID');
    assert.equal(response.metadata.products_empty_reason, 'identity_mismatch');
    assert.ok(!JSON.stringify(response).includes(c.oldClaim));
    assert.equal(__internal.normalizeRecoCatalogProduct(conflicting), null, 'bad recalled evidence cannot enter grounding');
  });
}

test('a matching canonical product retains its model rationale and confidence', () => {
  const c = CASES[0];
  const same = { ...candidate(c), score: 91, reasons: ['A reason for this exact product'], warnings: ['Patch test'], step: 'cleanser' };
  const merged = __internal.mergeRecoPlanWithGroundedCandidate(same, candidate(c));
  const projected = recommendationItemToSignal(merged, { confidenceBasis: 'model_self_report' });
  assert.ok(projected.value.why.includes('A reason for this exact product'));
  assert.ok(projected.value.watchouts.includes('Patch test'));
  assert.equal(projected.value.lane_confidence.level, 'high');
  const positional = __internal.mergeRecoPlanWithGroundedCandidate({ ...same, __pivota_score_basis: 'positional' }, candidate(c));
  assert.equal(recommendationItemToSignal(positional, { confidenceBasis: 'model_self_report' }).value.lane_confidence.level, null);
});

test('an unpriced/unlinked replacement never inherits plan price, link, image, group or notes', () => {
  const c = CASES[0];
  const merged = __internal.mergeRecoPlanWithGroundedCandidate(plan(c), {
    product_id: c.id, merchant_id: 'external_seed', name: c.name,
  });
  assert.equal(merged.price, null);
  const actual = recommendationItemToSignal(merged).value;
  assert.equal(actual.product.url, null);
  assert.equal(actual.product.image_url, null);
  assert.equal(actual.product.product_ref, null);
  assert.deepEqual(actual.notes, []);
  assert.ok(!JSON.stringify(merged).includes(c.oldId));
});

test('signature aliases and evidence roots are checked, but retailer/source/group IDs are not guessed', () => {
  const c = CASES[0];
  for (const fragment of [
    { sku: { product_id: c.oldId } }, { product: { product_id: c.oldId } },
    { canonical_product_ref: { product_id: c.oldId } },
    { pdp_open: { get_pdp_v2_payload: { product_ref: { product_id: c.oldId } } } },
    { product_intel: { subject: { kind: 'product', id: c.oldId } } },
    { product_url: url(c.oldId) + '?utm_source=test' },
  ]) assert.equal(recommendationIdentityConflict({ product_id: c.id, ...fragment }), true);
  for (const fragment of [
    { url: 'https://retailer.example/products/a-retailer-slug' },
    { url: `https://pivota.cc.evil.test/products/${c.oldId}` },
    { product_id: 'ext_source_id', canonical_product_ref: { product_id: c.id }, url: url(c.id) },
    { pdp_open: { subject: { type: 'product_group', id: 'group_other_namespace' } } },
    { product_intel: { alternatives: [{ product_id: c.oldId }] } },
  ]) assert.equal(recommendationIdentityConflict({ product_id: c.id, ...fragment }), false);
});

test('identity suppression backfills from the next consistent item and counts only survivors as served', async () => {
  const c = CASES[0];
  const bad = { ...candidate(c), pdp_url: url(c.oldId), notes: [c.oldClaim] };
  const response = await bridge([bad, candidate(CASES[1])])({ need: 'beauty products', limit: 1 });
  assert.equal(response.signals.length, 1);
  assert.equal(response.signals[0].value.product.product_id, CASES[1].id);
  assert.equal(response.signals[0].value.rank, 1);
  assert.equal(response.metadata.identity_mismatch_suppressed, 1);
  assert.equal(response.metadata.products_empty_reason, null);
});

for (const need of ['a foundation for my house', 'the foundation of a building', 'concrete foundation',
  'oil for my chainsaw', 'engine oil', 'machine oil', 'lubricant for a lawn mower']) {
  test(`contextual non-beauty request never calls generation: ${need}`, async () => {
    let calls = 0;
    const recommend = makeRecommendProducts({ isEnabled: () => true, generate: async () => { calls++; return {}; } });
    assert.ok(offVerticalMarker(need));
    const response = await recommend({ need });
    assert.equal(calls, 0);
    assert.deepEqual(response.signals, []);
  });
}
for (const need of ['foundation to wear around the house', 'foundation for my face', 'a facial oil for dry skin',
  'a lipstick to match my dress', 'a booster box of sheet masks', 'sunscreen while using my chainsaw',
  'a cleansing oil to remove machine grease from my hands', 'a cleanser to remove engine oil from my hands',
  'a foundation for a house party', 'a facial oil, not engine oil']) {
  test(`valid beauty context remains allowed: ${need}`, () => assert.equal(offVerticalMarker(need), null));
}


test('a measured price violation downgrades a replacement product even though its model band was suppressed', async () => {
  const c = CASES[0];
  const merged = __internal.mergeRecoPlanWithGroundedCandidate(plan(c), candidate(c, {price: {amount: 50, currency: 'USD'}}));
  const response = await bridge([merged])({need: 'a cleanser', constraints: {price_max: 25, currency: 'USD'}});
  assert.equal(response.signals.length, 1);
  assert.equal(response.signals[0].value.lane_confidence.basis, 'catalog_rebound');
  assert.equal(response.signals[0].value.lane_confidence.level, 'low');
  assert.equal(response.metadata.constraint_violations_returned, 1);
});

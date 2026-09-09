'use strict';

// #2155: "a bronzer for contouring my cheekbones, warm undertone" answers with The Ordinary
// Soothing & Barrier Support Serum at the strongest confidence label the surface can emit.
// Nothing in the lane asks whether the answer came back in the category the buyer named. The
// domain rules that would catch it live in an LLM PROMPT, and the catalog path — which produced
// the three-cleanser answer measured on prod 2026-09-09 — never reads a prompt at all. So the
// question has to be asked after every answer path converges, which is what this adds.
//
// IT REPORTS; IT DOES NOT ACT. The corpus at the bottom is the evidence that will decide whether
// acting is safe, and it is the reason enforcement is a separate change: #2149 already emptied
// in-vertical buyers' shortlists once by acting on a signal that looked good enough.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyRecoRequestCategory,
  classifyRecoItemCategory,
  evaluateRecoCategoryFidelity,
} = require('../src/auroraBff/recoCategoryFidelity');
const { classifyBeautyCoarseCandidate } = require('../src/shared/beautyRecoCoarseClassifier');

const evaluate = (requestText, items) =>
  evaluateRecoCategoryFidelity({ requestText, items, classifyCoarse: classifyBeautyCoarseCandidate });

const SERUM = { category_path: 'beauty/skincare/treat/serum', title: 'Soothing & Barrier Support Serum' };
const CLEANSER = { category_path: 'beauty/skincare/cleanse/gel', title: 'Revitalising Cleansing Gel' };
const BRONZER = { category_path: 'beauty/makeup/face/bronzer', title: 'Warm Bronzer' };
const UNKNOWN = { title: 'Mystery Item' };

test('the reported defect gets a verdict', () => {
  const out = evaluate('a bronzer for contouring my cheekbones, warm undertone', [SERUM, CLEANSER, CLEANSER]);
  assert.equal(out.verdict, 'off_category');
  assert.equal(out.request_category, 'makeup');
  assert.deepEqual(out.item_categories, ['skincare', 'skincare', 'skincare']);
});

test('the same need answered with a bronzer is matched', () => {
  assert.equal(evaluate('a bronzer for contouring my cheekbones', [BRONZER]).verdict, 'matched');
});

test('ONE matching item is enough — a mixed answer is not off_category', () => {
  // Deliberately generous. A shortlist that contains what was asked for plus adjacent steps is a
  // routine, not a wrong answer, and treating it as one is how a useful answer gets emptied.
  const out = evaluate('a bronzer for contouring', [SERUM, BRONZER, CLEANSER]);
  assert.equal(out.verdict, 'matched');
  assert.equal(out.matching_item_count, 1);
});

test('off_category is unreachable without a confident request category', () => {
  for (const need of ['something nice for my girlfriend', 'help me build a routine', 'a serum and a lipstick']) {
    const out = evaluate(need, [SERUM]);
    assert.equal(out.verdict, 'unresolved', `"${need}" must not produce a verdict that can be acted on`);
    assert.equal(out.request_category, null);
  }
});

test('off_category is unreachable when no item can be classified', () => {
  const out = evaluate('a bronzer for contouring', [UNKNOWN, UNKNOWN]);
  assert.equal(out.verdict, 'unresolved');
  assert.equal(out.resolved_item_count, 0);
});

test('an empty shortlist is unresolved, not off_category', () => {
  // There is nothing to be wrong about, and a verdict here would later empty an already-empty list
  // while attributing a reason the lane never established.
  assert.equal(evaluate('a bronzer for contouring', []).verdict, 'unresolved');
});

test('category_path is authoritative and the coarse classifier is the fallback', () => {
  assert.equal(classifyRecoItemCategory(BRONZER).category, 'makeup');
  assert.equal(classifyRecoItemCategory(BRONZER).reason, 'category_path');
  // No path: falls back. The coarse classifier reads the title.
  const fallback = classifyRecoItemCategory(
    { title: 'Warm Bronzer Contour Powder' },
    { classifyCoarse: classifyBeautyCoarseCandidate },
  );
  assert.equal(fallback.category, 'makeup');
  assert.equal(fallback.reason, 'coarse_classifier');
  // Body care files under beauty/skincare/moisturize/ in this catalog (measured 2026-09-09), so it
  // must read as skincare rather than as its own category or a mismatch. Asserted on BOTH branches:
  // via category_path, and via the coarse classifier, which returns its own 'bodycare' scope. If
  // that mapped to a category of its own, every body-lotion answer to a skincare need would read
  // off_category — a false mismatch on the largest category in the catalog.
  assert.equal(classifyRecoItemCategory({ category_path: 'beauty/skincare/moisturize/cream' }).category, 'skincare');
  const bodycare = classifyRecoItemCategory({ title: 'Coconut Body Lotion' }, { classifyCoarse: classifyBeautyCoarseCandidate });
  assert.equal(bodycare.category, 'skincare');
  assert.equal(bodycare.reason, 'coarse_classifier_bodycare');
  assert.equal(evaluate('a fragrance free moisturiser', [{ title: 'Coconut Body Lotion' }]).item_categories[0], 'skincare');
  assert.equal(classifyRecoItemCategory({}, { classifyCoarse: classifyBeautyCoarseCandidate }).category, null);
});

test('the more specific term wins when one contains the other', () => {
  // "a set of makeup brushes" names ONE thing. Without this it matches beauty_tool and makeup and
  // resolves to null — refusing to see the single most common beauty-tool need there is.
  assert.equal(classifyRecoRequestCategory('a set of makeup brushes for my kit').category, 'beauty_tool');
  assert.equal(classifyRecoRequestCategory('a makeup brush').category, 'beauty_tool');
  // But two genuinely different terms still refuse.
  assert.equal(classifyRecoRequestCategory('a serum and a lipstick').category, null);
});

// --- THE EVIDENCE THAT GATES ENFORCEMENT -------------------------------------------
//
// The `null` rows are the safety corpus: every one is a need where a confident wrong answer would
// empty a real buyer's shortlist. A false positive here is the #2149 regression, so the bar is ZERO
// — not "few". Recall is allowed to be imperfect; a missed classification costs a report, not a
// buyer. CAVEAT, stated because it matters: this corpus is hand-written, so it measures the
// classifier against needs I thought of. It is not a sample of real traffic.
const CORPUS = [
  ['a bronzer for contouring my cheekbones, warm undertone', 'makeup'],
  ['a lipstick in a warm nude', 'makeup'],
  ['an eyeshadow palette for beginners', 'makeup'],
  ['full coverage foundation for oily skin', 'makeup'],
  ['waterproof mascara', 'makeup'],
  ['shampoo for oily scalp', 'haircare'],
  ['a leave-in conditioner for curly hair', 'haircare'],
  ['dry shampoo that does not leave residue', 'haircare'],
  ['a perfume for evenings', 'fragrance'],
  ['cologne for my dad', 'fragrance'],
  ['a set of makeup brushes for my kit', 'beauty_tool'],
  ['a beauty blender sponge', 'beauty_tool'],
  ['a gua sha for facial massage', 'beauty_tool'],
  ['a gentle retinol for beginners', 'skincare'],
  ['i have acne issues, and please recommend some products', 'skincare'],
  ['something for clogged pores and blackheads', 'skincare'],
  // --- must refuse ---
  ['something nice for my girlfriend', null],
  ['a gift set under 50 dollars', null],
  ['help me build a routine', null],
  ['what should i use in the morning', null],
  ['i want to look less tired', null],
  ['products for a wedding', null],
  ['a serum and a lipstick', null],
  ['something for sensitive skin and a bold lip', null],
  ['my skin feels tight after washing', null],
  ['korean beauty recommendations', null],
  ['what is trending right now', null],
  ['a travel kit for a two week trip', null],
  // BARE-NOUN LEAKS. Every one of these contains a word the makeup family would own if its patterns
  // were unqualified (cream, powder, spray, palette, brush). The off-vertical gate learned this the
  // hard way — a wire brush set, a dishwasher sponge, a laptop colour palette — and the same
  // qualifiers are copied here for the same reason.
  ['a cream for my hands', null],
  ['baby powder for nappy rash', null],
  ['a spray for my plants', null],
  ['a colour palette for my website', null],
  ['a wire brush for the grill', null],
  ['a fragrance-free moisturiser for eczema', null],
  ['sunscreen that does not pill under makeup', null],
];

test('the request classifier never invents a category — zero false positives', () => {
  const falsePositives = [];
  const wrongCategory = [];
  for (const [need, expected] of CORPUS) {
    const got = classifyRecoRequestCategory(need).category;
    if (got === expected) continue;
    if (expected === null) falsePositives.push(`${need} -> ${got}`);
    else if (got !== null) wrongCategory.push(`${need} -> ${got} (want ${expected})`);
  }
  assert.deepEqual(falsePositives, [], 'a false positive here is a buyer whose shortlist gets emptied');
  assert.deepEqual(wrongCategory, [], 'a confidently WRONG category is worse than no category');
});

test('recall is good enough to be worth reporting', () => {
  const specific = CORPUS.filter(([, expected]) => expected !== null);
  const hit = specific.filter(([need, expected]) => classifyRecoRequestCategory(need).category === expected);
  // Pinned as a floor, not an equality: recall may improve, and a test that fails on improvement
  // teaches people to delete it.
  assert.ok(hit.length >= 16, `recall regressed: ${hit.length}/${specific.length}`);
});

// --- the wiring ---------------------------------------------------------------------
//
// The module above can be perfect and reach nobody. This drives the REAL lane and reads the verdict
// off recommendation_meta, so deleting the engine hop or the result hop turns it red.

const CLIENT_ID = require.resolve('../src/auroraBff/auroraDecisionClient');
const ROUTES_ID = require.resolve('../src/auroraBff/routes');

async function laneFidelity(need, items) {
  delete require.cache[ROUTES_ID];
  delete require.cache[CLIENT_ID];
  const client = require('../src/auroraBff/auroraDecisionClient');
  const original = client.auroraChat;
  // routes.js destructures auroraChat at load, so the stub must be in place before the require.
  client.auroraChat = async () => ({
    answer: JSON.stringify({ recommendations: items, confidence: 0.8, warnings: [], missing_info: [] }),
  });
  try {
    const { __internal } = require('../src/auroraBff/routes');
    const res = await __internal.generateProductRecommendations({
      ctx: {
        request_id: 'req_fid', trace_id: 'trace_fid', aurora_uid: 'agent:test',
        lang: 'EN', trigger_source: 'agent_tool', state: null, backend_auth_headers: {},
      },
      profile: null, recentLogs: [], message: need, focus: need,
      includeAlternatives: false, debug: true, logger: null, budgetMs: 4000,
      entryType: 'direct', recoTriggerSource: 'agent_tool',
    });
    return res?.norm?.payload?.recommendation_meta?.category_fidelity || null;
  } finally {
    client.auroraChat = original;
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
  }
}

const LANE_SERUM = {
  brand: 'The Ordinary', name: 'Soothing & Barrier Support Serum', step: 'treatment',
  category_path: 'beauty/skincare/treat/serum', query_terms: ['serum'], reasons: ['r'],
};
const LANE_BRONZER = {
  brand: 'B', name: 'Warm Bronzer', step: 'other',
  category_path: 'beauty/makeup/face/bronzer', query_terms: ['bronzer'], reasons: ['r'],
};

test('the verdict reaches recommendation_meta on the real lane', async () => {
  const offCategory = await laneFidelity('a bronzer for contouring my cheekbones, warm undertone', [LANE_SERUM]);
  assert.ok(offCategory, 'the verdict must be on the payload, not only inside the module');
  assert.equal(offCategory.verdict, 'off_category');
  assert.equal(offCategory.request_category, 'makeup');

  const matched = await laneFidelity('a bronzer for contouring my cheekbones', [LANE_BRONZER]);
  assert.equal(matched.verdict, 'matched');

  // The lane the acne work fixed must keep reading `matched` — this verdict is stamped on the chat
  // lane's answers too, and a classifier that called a routine off-category would be worse than
  // no classifier at all.
  const acne = await laneFidelity('i have acne issues, and please recommend some products', [LANE_SERUM]);
  assert.equal(acne.verdict, 'matched');
});

test('reporting does not change the answer — nothing is emptied yet', async () => {
  // The whole shape of this change: the off_category turn still returns its (wrong) product. That
  // is deliberate. Acting on the verdict is a separate change, gated on the corpus above being
  // measured against real traffic rather than against needs I thought of.
  delete require.cache[ROUTES_ID];
  delete require.cache[CLIENT_ID];
  const client = require('../src/auroraBff/auroraDecisionClient');
  const original = client.auroraChat;
  client.auroraChat = async () => ({
    answer: JSON.stringify({ recommendations: [LANE_SERUM], confidence: 0.8, warnings: [], missing_info: [] }),
  });
  try {
    const { __internal } = require('../src/auroraBff/routes');
    const res = await __internal.generateProductRecommendations({
      ctx: { request_id: 'r', trace_id: 't', aurora_uid: 'agent:test', lang: 'EN', trigger_source: 'agent_tool', state: null, backend_auth_headers: {} },
      profile: null, recentLogs: [], message: 'a bronzer for contouring', focus: 'a bronzer for contouring',
      includeAlternatives: false, debug: true, logger: null, budgetMs: 4000,
      entryType: 'direct', recoTriggerSource: 'agent_tool',
    });
    assert.equal(res.norm.payload.recommendation_meta.category_fidelity.verdict, 'off_category');
    assert.equal(res.norm.payload.recommendations.length, 1, 'still served, on purpose');
    assert.equal(res.norm.payload.products_empty_reason ?? null, null);
  } finally {
    client.auroraChat = original;
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
  }
});

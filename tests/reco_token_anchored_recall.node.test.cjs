'use strict';

// THE FAMILY LABEL IS THE WIDEST WORD IN ITS OWN VOCABULARY.
//
// After #2057 the founder's probe -- "a gentle exfoliant for sensitive skin under $40", price_max 40
// -- returned only ONE conforming item against a limit of 3. The ceiling-keyed pool cache row shows
// why: the conforming arm's pool was
//
//   COSRX AHA/BHA exfoliant 23 | Lador ACV Treatment 36 (HAIR) |
//   Paul Mitchell Color Depositing Treatment 28.5 (HAIR) | Lador Hydro LPP 24 (HAIR) |
//   Park Jun LPP Protein 34 (HAIR) | The Ordinary Barrier Serum 13.09 (not an exfoliant)
//
// Every row under the ceiling; five of six irrelevant. The pool conformed on PRICE and not on
// MEANING, the LLM correctly refused the hair products, and one item survived. A top-up would have
// shipped hair products -- the fix is query relevance.
//
// Root cause: resolveRecoTargetStepIntent matched the need token ("exfoliant", added to the treatment
// patterns by #2045) but returned ONLY the family. The matched surface was discarded, so the recall
// plan could only ever query the generic family label "treatment" -- and this catalog's "treatment"
// vocabulary is shared with haircare.
//
// This suite pins: the resolver captures the token from the SAME regex pass that decided the family,
// the token leads the query pack with the family alias kept immediately behind it, and every context
// that captures NO token is byte-stable.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveRecoTargetStepIntent,
  collectHighConfidenceMatchDetails,
  normalizeMatchedStepToken,
} = require('../src/auroraBff/recoTargetStep');
const {
  resolveRecommendationTargetContext,
  buildSameFamilyQueryLevels,
} = require('../src/auroraBff/recommendationSharedStack');
const {
  buildBeautyDiscoveryQueryPackFromContract,
} = require('../src/findProductsMulti/policy');
const { buildRecoRecallPoolCacheKey } = require('../src/auroraBff/recoRecallPoolCache');
const { __internal } = require('../src/auroraBff/routes');

const FOUNDER_NEED = 'a gentle exfoliant for sensitive skin under $40';

function contextFor(args) {
  return resolveRecommendationTargetContext({ entryType: 'direct', ...args });
}

function executedQueries(targetContext, profileSummary = null) {
  const levels = __internal.buildRecoCatalogQueryLevels({
    targetContext,
    profileSummary,
    ingredientContext: null,
    lang: 'EN',
  });
  return levels.flatMap((level) => level.queries.map((q) => q.query));
}

function stepAwareContract(overrides = {}) {
  return {
    version: 'beauty_semantic_contract_v1',
    owner: 'aurora_reco_planner',
    planner_mode: 'step_aware',
    request_class: 'routine_followup',
    target_step_family: 'treatment',
    primary_role_id: 'treatment_primary',
    support_role_ids: [],
    semantic_family: 'treatment',
    allowed_step_families: ['treatment'],
    blocked_step_families: [],
    ingredient_hypotheses: [],
    source_surface: 'aurora_beauty_strict',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The resolver captures the matched surface token
// ---------------------------------------------------------------------------

test("the founder's need captures 'exfoliant', not just the family", () => {
  const resolved = resolveRecoTargetStepIntent({ text: FOUNDER_NEED });
  assert.equal(resolved.resolved_target_step, 'treatment');
  // Mutant killed: reverting the resolver hunk. Returning only the family is the defect -- the recall
  // plan then has nothing to query but "treatment", which this catalog shares with haircare.
  assert.equal(resolved.resolved_target_step_token, 'exfoliant');
  assert.equal(resolved.resolved_target_step_confidence, 'high');
});

test('the token comes from the SAME regex pass, so it is always literally present in the input', () => {
  const inputs = [
    FOUNDER_NEED,
    'a gentle face wash for oily skin',
    'looking for a sheet mask',
    'i want a good sunscreen',
    'recommend an essence',
  ];
  for (const input of inputs) {
    const details = collectHighConfidenceMatchDetails(input);
    for (const { token } of details) {
      // Mutant killed: re-scanning with a different mechanism (a second tokenizer, a lookup table).
      // A token that is not a substring of the input did not come from the pass that chose the family
      // and can disagree with it.
      assert.ok(
        input.toLowerCase().includes(token),
        `token "${token}" is not present in "${input}"`,
      );
    }
  }
});

test('an EXPLICIT step captures no token', () => {
  // Mutant killed: synthesizing a token from the explicit family label. It would only ever re-emit
  // the family word, adding a duplicate query and no information.
  assert.equal(resolveRecoTargetStepIntent({ explicitStep: 'treatment' }).resolved_target_step_token, null);
  assert.equal(resolveRecoTargetStepIntent({ explicitStep: 'cleanser' }).resolved_target_step_token, null);
  assert.equal(contextFor({ explicitStep: 'treatment' }).resolved_target_step_token, null);
});

test('an unresolved need captures no token', () => {
  const resolved = resolveRecoTargetStepIntent({ text: 'hello, what should i buy' });
  assert.equal(resolved.resolved_target_step, null);
  assert.equal(resolved.resolved_target_step_token, null);
});

test('a token identical to the family anchor is DROPPED, so nothing downstream changes', () => {
  // Mutant killed: keeping every token. "treatment" as a token adds a query identical to the anchor,
  // and "face oil" is ALREADY the oil family's anchor (#2047) -- both would churn plans for nothing.
  assert.equal(contextFor({ text: 'i need a treatment' }).resolved_target_step_token, null);
  assert.equal(contextFor({ text: 'cleanser' }).resolved_target_step_token, null);
  assert.equal(contextFor({ text: 'toner' }).resolved_target_step_token, null);
  assert.equal(contextFor({ text: 'face oil' }).resolved_target_step_token, null);
  assert.equal(contextFor({ text: 'sunscreen spf 50' }).resolved_target_step_token, null);
});

test('a token that says MORE than the family survives, including multi-word ones', () => {
  assert.equal(contextFor({ text: FOUNDER_NEED }).resolved_target_step_token, 'exfoliant');
  assert.equal(contextFor({ text: 'a gentle face wash' }).resolved_target_step_token, 'face wash');
  assert.equal(contextFor({ text: 'looking for a sheet mask' }).resolved_target_step_token, 'sheet mask');
  // DIVERGENCE, stated: the brief called "acne treatment" a byte-stable case. It is not treated as
  // one here, because the only rule that would suppress it -- "the token contains the family word" --
  // would ALSO suppress "sheet mask" and "face wash", which are exactly the tokens this fix exists to
  // capture. "acne treatment" is strictly more specific than "treatment", and the family anchor is
  // kept as the second query, so nothing is lost.
  assert.equal(contextFor({ text: 'acne treatment' }).resolved_target_step_token, 'acne treatment');
});

test('a CN need round-trips its CN token', () => {
  // CN aliases are first-class entries in STEP_QUERY_ALIASES (mask includes 面膜), so a CN token is a
  // query the ladder can already emit. Round-tripping it is the consistent choice; the EN family
  // alias still rides second, so a CN token that under-recalls is rescued.
  const ctx = contextFor({ text: '推荐一款面膜' });
  assert.equal(ctx.resolved_target_step, 'mask');
  assert.equal(ctx.resolved_target_step_token, '面膜');
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: '面膜',
    semanticContract: stepAwareContract({
      target_step_family: 'mask',
      primary_role_id: 'mask_primary',
      semantic_family: 'mask',
      allowed_step_families: ['mask'],
      target_step_token: '面膜',
    }),
  });
  // Mutant killed: stripping non-ASCII from the token (a "normalize" that empties CN) -- the CN lane
  // would silently degrade with no test to notice.
  assert.deepEqual(pack, ['面膜', 'mask']);
});

test('the token is normalized and bounded', () => {
  assert.equal(normalizeMatchedStepToken('  Sheet   MASK '), 'sheet mask');
  // Mutant killed: no length bound. The token becomes a query string; an unbounded one is a
  // caller-controlled payload on the search path.
  assert.equal(normalizeMatchedStepToken('x'.repeat(200)).length, 40);
  assert.equal(normalizeMatchedStepToken(null), '');
});

// ---------------------------------------------------------------------------
// 2. The query pack leads with the token, and KEEPS the family
// ---------------------------------------------------------------------------

test("the founder's pack leads with 'exfoliant' and keeps 'treatment' second", () => {
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'exfoliant sensitive skin',
    semanticContract: stepAwareContract({ target_step_token: 'exfoliant' }),
  });
  // Mutant killed: reverting the token-first hunk in buildDeterministicStrictSemanticQueryPack. The
  // primary arm is also the ONLY arm that carries the price ceiling (#2057), so the token must lead
  // it -- that is where conforming AND relevant candidates live.
  assert.equal(pack[0], 'exfoliant');
  // Mutant killed: replacing the family anchor with the token instead of leading with it. A token can
  // be over-narrow; the family arm is what rescues that.
  assert.equal(pack[1], 'treatment');
  assert.ok(pack.includes('exfoliant sensitive skin'), JSON.stringify(pack));
});

test('a token-anchored pack keeps its own decorated queries (the anchor exemption extends to it)', () => {
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'exfoliant sensitive skin',
    semanticContract: stepAwareContract({ target_step_token: 'exfoliant' }),
  });
  // Mutant killed: registering the token WITHOUT adding it to the pack anchors. #2047's substring
  // dedupe would then drop "exfoliant sensitive skin" as redundant with "exfoliant", costing the pack
  // its most specific query -- the same class of bug #2047 fixed for the family anchor.
  assert.equal(pack.length, 3);
  assert.deepEqual(pack, ['exfoliant', 'treatment', 'exfoliant sensitive skin']);
});

test('a contract with NO token packs exactly as it does today', () => {
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'exfoliant sensitive skin',
    semanticContract: stepAwareContract(),
  });
  // Mutant killed: leading with something whenever target_step_token is absent (e.g. falling back to
  // the raw query). Contexts that capture no token must not move at all.
  assert.deepEqual(pack, ['treatment', 'exfoliant sensitive skin']);
});

test('a token equal to the family anchor does not add a duplicate arm', () => {
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'treatment',
    semanticContract: stepAwareContract({ target_step_token: 'treatment' }),
  });
  // Mutant killed: dropping the `token !== anchor` guard in the pack -- "treatment" would be pushed
  // twice and burn one of only three slots.
  assert.deepEqual(pack, ['treatment']);
});

// ---------------------------------------------------------------------------
// 3. The ladder keeps the family alias behind the token
// ---------------------------------------------------------------------------

test('the step_only ladder level carries the token FIRST and the family alias second', () => {
  const levels = buildSameFamilyQueryLevels({
    targetContext: contextFor({ text: FOUNDER_NEED }),
    profileSummary: null,
    ingredientContext: null,
    lang: 'EN',
  });
  const stepOnly = levels.find((l) => l.ladder_level === 'step_only');
  // Mutant killed: replacing stepPrimary with the token in the step_only level instead of prepending.
  // The family alias must survive as its own query.
  assert.deepEqual(stepOnly.queries.map((q) => q.query), ['exfoliant', 'treatment']);
});

test('the ladder is byte-identical when no token is captured', () => {
  const withToken = buildSameFamilyQueryLevels({
    targetContext: contextFor({ explicitStep: 'treatment' }),
    profileSummary: null,
    ingredientContext: null,
    lang: 'EN',
  });
  const stepOnly = withToken.find((l) => l.ladder_level === 'step_only');
  // Mutant killed: emitting the anchor twice, or defaulting stepQueryAnchor to something other than
  // stepPrimary.
  assert.deepEqual(stepOnly.queries.map((q) => q.query), ['treatment']);
});

// ---------------------------------------------------------------------------
// 4. End to end through the real plan builder
// ---------------------------------------------------------------------------

test("the founder's need now executes 'exfoliant' before 'treatment'", () => {
  const queries = executedQueries(contextFor({ text: FOUNDER_NEED }));
  // Mutant killed: not threading targetStepToken into buildRecoRecallPlan at the step_aware call
  // sites. The token would reach the ladder but never the CONTRACT, and the pack -- which is what is
  // actually executed -- would still lead with "treatment".
  assert.equal(queries[0], 'exfoliant');
  assert.equal(queries[1], 'treatment');
});

test('no-token needs execute the same plan as today, minus a wasted slot', () => {
  // Measured against origin/main in this worktree: a treatment contract packed
  // ["treatment", "treatment treatment", <raw>] and a serum one ["serum", "serum serum", <raw>].
  // "treatment treatment" matches no title; it is `${semanticFamily} treatment` with semanticFamily
  // already equal to the family, and since #2047 the bare-anchor dedupe exemption admits it instead
  // of collapsing it. The freed slot is now a real query.
  const profile = { goal_primary: 'acne', goals: ['hydration'] };
  for (const args of [{ explicitStep: 'treatment' }, { text: 'i need a treatment' }]) {
    const queries = executedQueries(contextFor(args), profile);
    // Mutant killed: reverting buildFamilyQualifiedSemanticQuery.
    assert.ok(!queries.includes('treatment treatment'), JSON.stringify(queries));
    assert.equal(queries[0], 'treatment');
    assert.equal(queries.length, 3);
  }
  const serum = executedQueries(contextFor({ text: 'a serum' }), profile);
  assert.ok(!serum.includes('serum serum'), JSON.stringify(serum));
  assert.equal(serum[0], 'serum');
});

test('a qualifier that already names the family is not doubled up', () => {
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'acne spot fix',
    semanticContract: stepAwareContract({
      semantic_family: 'acne',
      concern_class: 'acne_urgent',
      primary_role_id: '',
    }),
  });
  // Mutant killed: `${qualifier} ${family}` unconditionally -- "acne treatment" is right, but a
  // qualifier of "treatment" would give "treatment treatment" and one of "acne treatment" would give
  // "acne treatment treatment".
  for (const query of pack) {
    const words = query.split(' ');
    assert.equal(new Set(words).size, words.length, `repeated word in "${query}"`);
  }
});

// ---------------------------------------------------------------------------
// 5. Pool cache separation
// ---------------------------------------------------------------------------

test('token-anchored runs get their own pool-cache row', () => {
  const tokenQueries = executedQueries(contextFor({ text: FOUNDER_NEED }));
  const familyQueries = executedQueries(contextFor({ explicitStep: 'treatment' }));
  const dims = { stepFamily: 'treatment', lang: 'EN', catalogSurface: 'beauty', plannerMode: 'step_aware' };
  const tokenKey = buildRecoRecallPoolCacheKey({ ...dims, queries: tokenQueries });
  const familyKey = buildRecoRecallPoolCacheKey({ ...dims, queries: familyQueries });
  // The queries dimension already discriminates, so no version bump is needed: a token-anchored run
  // executes a different query list and therefore hashes to a different row.
  // Mutant killed: keying only on the step family -- the family-anchored (hair-polluted) pool would
  // be served to token-anchored asks for up to 24 hours.
  assert.notEqual(tokenKey, familyKey);
  assert.match(tokenKey, /^[0-9a-f]{64}$/);
});

test('the ceiling still rides only the primary arm, which is now the token arm', () => {
  const { shouldSendPriceCeilingOnQueryArm } = require('../src/auroraBff/recoPriceCeiling');
  const queries = executedQueries(contextFor({ text: FOUNDER_NEED }));
  assert.equal(queries[0], 'exfoliant');
  // Mutant killed: moving the ceiling off arm 0, or leading the pack with the family again. #2057's
  // rule is that exactly one arm is constrained; this change is what makes that arm the relevant one.
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: 0 }), true);
  assert.equal(shouldSendPriceCeilingOnQueryArm({ queryIndex: 1 }), false);
});

// ---------------------------------------------------------------------------
// 6. Lanes that must not move
// ---------------------------------------------------------------------------

test('the grounding pass resolves its token PER ITEM and does not throw', async () => {
  // The grounding pass has no request-level `targetContext` in scope at all; it resolves a step per
  // LLM item. Mutant killed: referencing `targetContext` there -- an undeclared identifier, which
  // optional chaining does NOT guard, so the whole grounding pass would throw at runtime.
  const out = await __internal.groundRecoRecommendationsFromCatalog({
    recommendations: [{ name: 'A gentle exfoliant', step: 'treatment' }],
    ctx: { lang: 'EN' },
    logger: null,
    defaultTargetContext: null,
  });
  assert.ok(out);
  assert.ok(Array.isArray(out.recommendations));
});

test('the chat lane still resolves a generic ask to the concern framework, with no token', () => {
  const chat = resolveRecommendationTargetContext({
    text: 'my skin is dry and dull, what should i use',
    entryType: 'chat',
  });
  // Mutant killed: capturing a token on the framework path. Framework contexts have no
  // resolved_target_step at all, so a token there would anchor a plan that does not use one.
  assert.equal(chat.resolved_target_step, null);
  assert.equal(chat.resolved_target_step_token, null);
  assert.ok(Array.isArray(chat.framework_roles));
});

// ---------------------------------------------------------------------------
// 7. The family-qualified query builder, tested directly
// ---------------------------------------------------------------------------

// Its two guards mask each other through the pack: with only one of them removed the pack still looks
// right, so each has to be driven on its own.
const { buildFamilyQualifiedSemanticQuery } = require('../src/findProductsMulti/policy');

test('a qualifier identical to the family yields NO query', () => {
  // Mutant killed: removing the `q === f` guard. `${semanticFamily} treatment` with semanticFamily
  // already "treatment" is the live "treatment treatment" query -- it matches no title and burns one
  // of only three slots.
  assert.equal(buildFamilyQualifiedSemanticQuery('treatment', 'treatment'), '');
  assert.equal(buildFamilyQualifiedSemanticQuery('serum', 'serum'), '');
  assert.equal(buildFamilyQualifiedSemanticQuery('  Treatment ', 'treatment'), '');
});

test('a qualifier that already names the family is returned as-is', () => {
  // Mutant killed: removing the `q.split(' ').includes(f)` guard -- "acne treatment" would become
  // "acne treatment treatment".
  assert.equal(buildFamilyQualifiedSemanticQuery('acne treatment', 'treatment'), 'acne treatment');
  assert.equal(buildFamilyQualifiedSemanticQuery('oil control treatment', 'treatment'), 'oil control treatment');
});

test('an unrelated qualifier is joined to the family', () => {
  assert.equal(buildFamilyQualifiedSemanticQuery('acne', 'treatment'), 'acne treatment');
  assert.equal(buildFamilyQualifiedSemanticQuery('brightening', 'treatment'), 'brightening treatment');
  assert.equal(buildFamilyQualifiedSemanticQuery('', 'treatment'), '');
  assert.equal(buildFamilyQualifiedSemanticQuery('acne', ''), 'acne');
});

test('a token equal to the anchor must not jump ahead of a more specific role label', () => {
  const pack = buildBeautyDiscoveryQueryPackFromContract({
    rawQuery: 'oily skin treatment',
    semanticContract: stepAwareContract({
      primary_role_id: 'oil_control_treatment',
      semantic_family: 'oil_control',
      concern_class: 'oil_control',
      target_step_token: 'treatment',
    }),
  });
  // Mutant killed: dropping the `token !== anchor` guard on leadWithStepToken. The bare family word
  // would then be pushed FIRST -- ahead of "oil control treatment" -- which is precisely the
  // hair-polluted generic query this whole PR exists to stop leading with.
  assert.equal(pack[0], 'oil control treatment', JSON.stringify(pack));
  assert.ok(!pack.slice(0, 1).includes('treatment'));
});

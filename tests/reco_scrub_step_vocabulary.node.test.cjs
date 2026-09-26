'use strict';

// "A FACE SCRUB FOR DULL SKIN" RETURNED A CLEANSING GEL.
//
// Live 2026-08-21: the ask came back with a Jurlique Revitalising Cleansing GEL. No scrub.
//
// Root cause, verified against the shipped vocabularies: "scrub" appeared in NO step vocabulary.
// recoTargetStep's treatment patterns carried exfoliators?|exfoliants?|exfoliating treatment|
// liquid exfoliant|resurfacing treatment but never scrub/polish/gommage, and the cleanser patterns are
// cleanser|face wash|facial wash|cleansing gel|cleansing foam|cleansing milk -- "face scrub" matches
// NEITHER. The need resolved to step 'none', fell to the generic Branch B, and recall was weak. Same
// class as the "exfoliant" gap #2059 fixed, one vocabulary hop down.
//
// THE FAMILY DECISION IS EMPIRICAL, NOT ASSUMED. `normalizeCandidateStep` resolves CANDIDATE rows
// through the SAME STEP_PATTERNS the NEED goes through, so adding scrub to the treatment patterns
// moves both sides together and the recalled rows come back same_family. Measured before the change:
// every scrub title resolved candidate_step=null. Measured after: treatment, same_family. The
// alternative -- mapping the need to `cleanser` -- would have made every recalled scrub
// incompatible_family, since treatment and cleanser are not even adjacent in
// CANONICAL_STEP_FAMILY_MAP.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveRecoTargetStepIntent,
  getRecoTargetFamilyRelation,
  normalizeRecoTargetStep,
} = require('../src/auroraBff/recoTargetStep');
const {
  resolveRecommendationTargetContext,
  normalizeCandidateStep,
  finalizeRecommendationCandidatePools,
} = require('../src/auroraBff/recommendationSharedStack');
const { deriveRecoNeedIntentSignals } = require('../src/auroraBff/recoGentlenessSignals');
const { __internal: hybridInternal } = require('../src/auroraBff/usecases/recoHybridResolveCandidates');
const { __internal: routesInternal } = require('../src/auroraBff/routes');

const SCRUB_NEED = 'a face scrub for dull skin';
const GENTLE_NEED = 'a gentle exfoliant for sensitive skin under $40';

const ctxFor = (text) => resolveRecommendationTargetContext({ text, entryType: 'direct' });
const ids = (rows) => rows.map((r) => r.product_id).join(',');
const stepOf = (name, extra = {}) => normalizeCandidateStep({ name, ...extra }, {}).candidate_step;
const domainOf = (title) => hybridInternal.classifySkincareCandidate({ title }).classification;

// Title-only rows: the coordinator's catalog sample shows these rows carry a NULL category_label, so
// the title is all the classifier has. That is exactly what the new vocabulary has to handle.
function row(product_id, name, price_amount, extra = {}) {
  return { product_id, merchant_id: 'm1', name, price_amount, currency: 'USD', ...extra };
}

const JURLIQUE_GEL = row('gel', 'Jurlique Revitalising Cleansing Gel', 30);
const FACE_SCRUB = row('face', 'ENERGIZING FACE SCRUB 50ml', 22);
const SIGMAGIC = row('sig', 'Sigmagic Scrub', 18);
const BODY_SCRUB = row('body', 'Perfume Nourishing Body Scrub', 15);
const NATURIUM = row('nat', 'Naturium BHA 2% Liquid Exfoliant', 19);

function queriesFor(text) {
  const levels = routesInternal.buildRecoCatalogQueryLevels({
    targetContext: ctxFor(text),
    profileSummary: null,
    ingredientContext: null,
    lang: 'EN',
  });
  return levels.flatMap((level) => level.queries.map((q) => q.query));
}

// ---------------------------------------------------------------------------
// 1. The need resolves, and scrub leads the query pack
// ---------------------------------------------------------------------------

test('"a face scrub for dull skin" resolves to a step instead of falling to generic', () => {
  const resolved = resolveRecoTargetStepIntent({ text: SCRUB_NEED });
  // Mutant killed: reverting the scrub vocabulary. On main this returned resolved_target_step=null,
  // confidence 'none' -- the need fell through to the generic Branch B, which is why a cleansing gel
  // could answer it.
  assert.equal(resolved.resolved_target_step, 'treatment');
  assert.equal(resolved.resolved_target_step_confidence, 'high');
  // #2059 captures the matched surface, so "face scrub" -- not the family label -- anchors recall.
  assert.equal(resolved.resolved_target_step_token, 'face scrub');
});

test('the query pack LEADS with the scrub token and keeps the family second', () => {
  const queries = queriesFor(SCRUB_NEED);
  // Mutant killed: adding the vocabulary without the EXACT_ALIAS_MAP entries, or breaking #2059's
  // token capture -- the pack would lead with the generic "treatment", which is the vocabulary this
  // catalog shares with everything else.
  assert.equal(queries[0], 'face scrub');
  assert.equal(queries[1], 'treatment');
});

test('CN 磨砂 resolves and anchors the same way', () => {
  const resolved = resolveRecoTargetStepIntent({ text: '磨砂膏推荐' });
  // Mutant killed: an EN-only scrub vocabulary.
  assert.equal(resolved.resolved_target_step, 'treatment');
  assert.equal(queriesFor('磨砂膏推荐')[0], '磨砂膏');
  assert.equal(normalizeRecoTargetStep('磨砂'), 'treatment');
  assert.equal(normalizeRecoTargetStep('磨砂膏'), 'treatment');
});

test('the scrub vocabulary is word-anchored and does not swallow neighbours', () => {
  assert.equal(normalizeRecoTargetStep('scrub'), 'treatment');
  assert.equal(normalizeRecoTargetStep('face scrub'), 'treatment');
  assert.equal(normalizeRecoTargetStep('gommage'), 'treatment');
  // Mutant killed: adding a bare `polish` alternative -- "nail polish" would resolve to a facial
  // treatment step. Only the face-qualified forms are in the vocabulary.
  assert.equal(normalizeRecoTargetStep('nail polish'), null);
  assert.equal(normalizeRecoTargetStep('face polish'), 'treatment');
  // Mutant killed: dropping the \b anchor. "scrubber" is an IMPLEMENT (#2064 rejects it); an
  // unanchored `scrubs?` would resolve it to a facial treatment step.
  assert.equal(normalizeRecoTargetStep('scrubber'), null);
  assert.equal(normalizeRecoTargetStep('body scrubber'), null);
  // The neighbours still resolve as they did.
  assert.equal(normalizeRecoTargetStep('cleanser'), 'cleanser');
  assert.equal(normalizeRecoTargetStep('cleansing gel'), 'cleanser');
});

// ---------------------------------------------------------------------------
// 2. THE FAMILY DECISION: recalled scrub rows are SAME family
// ---------------------------------------------------------------------------

test('facial scrub ROWS resolve to the same family the need does', () => {
  const need = resolveRecoTargetStepIntent({ text: SCRUB_NEED }).resolved_target_step;
  for (const title of [
    'ENERGIZING FACE SCRUB 50ml', 'Sigmagic Scrub', 'Melon Scrub',
    'NUXE Radiance Face Scrub', 'Gentle Sugar Face Scrub', 'Facial Polish', '磨砂膏',
  ]) {
    // Mutant killed: mapping the NEED to `cleanser` instead of `treatment`. Candidate rows resolve
    // through the SAME STEP_PATTERNS, so they would land on treatment while the need sat on cleanser
    // -- and treatment/cleanser are not even adjacent, so every recalled scrub would be
    // incompatible_family and hard-rejected. Measured: null on main, treatment now, both sides.
    assert.equal(stepOf(title), 'treatment', `${title} candidate_step`);
    assert.equal(getRecoTargetFamilyRelation(need, stepOf(title)), 'same_family', title);
  }
});

test('the reported symptom: a cleansing gel is now incompatible with a face-scrub need', () => {
  const need = resolveRecoTargetStepIntent({ text: SCRUB_NEED }).resolved_target_step;
  // Mutant killed: any change that leaves the need unresolved. With step 'none' there is no family
  // relation at all and a cleansing gel is as good an answer as anything -- which is what shipped.
  assert.equal(stepOf('Jurlique Revitalising Cleansing Gel'), 'cleanser');
  assert.equal(getRecoTargetFamilyRelation(need, 'cleanser'), 'incompatible_family');
});

test('end to end: the face-scrub ask returns scrubs, not the cleansing gel', () => {
  const state = finalizeRecommendationCandidatePools(
    [JURLIQUE_GEL, FACE_SCRUB, SIGMAGIC, BODY_SCRUB],
    { targetContext: ctxFor(SCRUB_NEED) },
  );
  // Mutant killed: reverting the vocabulary -- the gel would be viable again.
  assert.equal(ids(state.selected_recommendations), 'face,sig');
  const rejected = state.hard_reject.map((r) => `${r.product.product_id}:${r.reason}`);
  assert.ok(rejected.includes('gel:incompatible_family'), rejected.join(' '));
});

// ---------------------------------------------------------------------------
// 3. Composition with #2062 (gentleness) and #2064 (implements / body scope)
// ---------------------------------------------------------------------------

test('#2062: an explicit scrub ask suppresses the gentleness demotion, end to end', () => {
  const signals = deriveRecoNeedIntentSignals({ text: SCRUB_NEED });
  assert.equal(signals.scrub_requested, true);
  assert.equal(signals.gentleness_preferred, false);

  // The end-to-end half: with a scrub ask, a scrub must NOT be pushed below a chemical exfoliant.
  const state = finalizeRecommendationCandidatePools([FACE_SCRUB, NATURIUM], {
    targetContext: ctxFor(SCRUB_NEED),
  });
  // Mutant killed: #2062's demotion firing on a scrub ask -- the buyer asked for a scrub and would
  // get the chemical exfoliant first. Relevance order is preserved, so the scrub stays where recall
  // put it.
  assert.equal(ids(state.viable_candidate_pool), 'face,nat');

  // ...and the gentleness ask still demotes scrubs, as #2062 requires.
  const gentle = finalizeRecommendationCandidatePools([FACE_SCRUB, NATURIUM], {
    targetContext: ctxFor(GENTLE_NEED),
  });
  assert.equal(ids(gentle.viable_candidate_pool), 'nat,face');

  // THE CASE THE SUPPRESSION EXISTS FOR: both signals fire at once. Without it the buyer who asked
  // for a GENTLE FACE SCRUB gets the chemical exfoliant first -- the demotion firing on the very
  // thing that was asked for.
  // Mutant killed: removing the scrub_requested guard from applyRecoGentlenessPreference and
  // resolveRecoGentlenessRankTier.
  const both = deriveRecoNeedIntentSignals({ text: 'a gentle face scrub for sensitive skin' });
  assert.equal(both.gentleness_preferred, true);
  assert.equal(both.scrub_requested, true);
  const bothState = finalizeRecommendationCandidatePools([FACE_SCRUB, NATURIUM], {
    targetContext: ctxFor('a gentle face scrub for sensitive skin'),
  });
  assert.equal(ids(bothState.viable_candidate_pool), 'face,nat');
});

test('#2064: scrub FORMULATIONS are admitted; implements are not', () => {
  // Mutant killed: adding `scrub` to #2064's implement head vocabulary. A sugar scrub is a product;
  // a loofah is not.
  for (const title of ['Sugar Scrub', 'ENERGIZING FACE SCRUB 50ml', 'Gentle Sugar Face Scrub', 'Melon Scrub']) {
    assert.notEqual(domainOf(title), 'explicit_non_skincare', title);
  }
  assert.equal(domainOf('Loofah'), 'explicit_non_skincare');
  assert.equal(domainOf('Body Scrubber'), 'explicit_non_skincare');
});

test('#2064: BODY scrubs never surface for a facial ask', () => {
  // Their only body signal is in the TITLE -- these rows carry a NULL category_label -- so this is
  // NON_FACE_SUPPORT_RE reading the title, which is the path #2064 left intact.
  // Mutant killed: relying on category fields alone for body exclusion.
  // Mutant killed: dropping `body` from NON_FACE_SUPPORT_RE. "Perfume Nourishing Body Scrub" would
  // still be rejected -- but only incidentally, by `perfume` in the fatal list -- so the assertion
  // has to use a body row whose ONLY blocked word is "body".
  assert.equal(domainOf('BLACK BEAN POD | 4PM | BODY SCRUB'), 'explicit_non_face_supportive');
  assert.equal(domainOf('Nourishing Body Scrub'), 'explicit_non_face_supportive');
  assert.equal(domainOf('Perfume Nourishing Body Scrub'), 'explicit_non_skincare');
  const state = finalizeRecommendationCandidatePools([FACE_SCRUB, BODY_SCRUB], {
    targetContext: ctxFor(SCRUB_NEED),
  });
  assert.equal(ids(state.selected_recommendations), 'face');
  assert.ok(!ids(state.viable_candidate_pool).includes('body'));
});

// ---------------------------------------------------------------------------
// 4. Regression: tonight's chain is unchanged for the gentle ask
// ---------------------------------------------------------------------------

test("the gentle-exfoliant ask is unchanged: chemical still leads", () => {
  const resolved = resolveRecoTargetStepIntent({ text: GENTLE_NEED });
  // Mutant killed: a scrub alternative broad enough to capture "exfoliant" first and change #2059's
  // token, which would move the lead query away from what the buyer wrote.
  assert.equal(resolved.resolved_target_step, 'treatment');
  assert.equal(resolved.resolved_target_step_token, 'exfoliant');
  assert.equal(queriesFor(GENTLE_NEED)[0], 'exfoliant');

  const pool = [
    row('ord', 'The Ordinary Salicylic Acid 2% Solution', 5.16, { product_type: 'treatment' }),
    row('nuxe', 'NUXE Radiance Face Scrub', 29, { product_type: 'treatment' }),
    row('tirtir', 'TIRTIR Matcha Bubble Tea Scrub', 20, { product_type: 'treatment' }),
    row('axis', 'AXIS-Y PHA Resurfacing Glow Peel', 6, { product_type: 'treatment' }),
    row('nat', 'Naturium BHA 2% Liquid Exfoliant', 19, { product_type: 'treatment' }),
  ];
  const gentle = finalizeRecommendationCandidatePools(pool, { targetContext: ctxFor(GENTLE_NEED) });
  // #2062's exact expected ordering, still holding after the vocabulary change.
  assert.equal(ids(gentle.viable_candidate_pool), 'ord,axis,nat,nuxe,tirtir');
  const plain = finalizeRecommendationCandidatePools(pool, { targetContext: ctxFor('an exfoliant') });
  assert.equal(ids(plain.viable_candidate_pool), 'ord,nuxe,tirtir,axis,nat');
});

test('KNOWN TRADE-OFF: a scrub row structurally categorised as a Cleanser is incompatible', () => {
  // structured_category beats the title in normalizeCandidateStep, so a scrub row whose product_type
  // says "Cleanser" resolves cleanser and is hard-rejected for a face-scrub need. That is correct for
  // the Jurlique gel and wrong for a genuine wash-off "Cleansing Scrub".
  //
  // Not fixed here: the only lever is widening CANONICAL_STEP_FAMILY_MAP so treatment and cleanser
  // become adjacent, which would change EVERY treatment need (retinol, acne) and wants its own
  // measurement. Pinned so it is visible and cannot drift unnoticed.
  assert.equal(stepOf('ENERGIZING FACE SCRUB 50ml', { product_type: 'Cleanser' }), 'cleanser');
  assert.equal(stepOf('ENERGIZING FACE SCRUB 50ml', { category: 'Face Scrub' }), 'treatment');
  assert.equal(stepOf('ENERGIZING FACE SCRUB 50ml'), 'treatment');
});

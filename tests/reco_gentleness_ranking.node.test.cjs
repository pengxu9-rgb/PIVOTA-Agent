'use strict';

// GENTLENESS-AWARE RANKING inside the conforming pool.
//
// Live 2026-08-21 (PRICE_MAX=40), "a gentle exfoliant for sensitive skin under $40" returned 3/3
// CONFORMING and semantically weak:
//   #1 The Ordinary Salicylic Acid 2%  $5.16  (right)
//   #2 NUXE Radiance Face SCRUB        $29
//   #3 TIRTIR Matcha Bubble Tea SCRUB  $20
// ...while the catalog held conforming chemical options (AXIS-Y PHA $6, COSRX AHA/BHA $23, Naturium
// BHA 2% $19). Price and recall were already solved by #2057/#2059/#2060; this is ordering WITHIN the
// conforming pool.
//
// THE TRAP THIS SUITE EXISTS TO PIN. computeCandidateContextSignals already scores sensitivity, but
// off the PROFILE -- and the agent lane passes `profile: null`. The obvious fix is to derive
// sensitivity from the need text. That would make the defect WORSE: the same function sets
// `constraint_conflict = true` (score forced to 0) when sensitivity === 'high' AND the product matches
// /\b(retinol|retinoid|aha|bha|acid|peel|exfoliat|benzoyl)\b/, so "gentle ... sensitive skin" would
// HARD-ZERO every chemical exfoliant and leave the shortlist full of scrubs.
//
// So the need-text signals here are RANKING-ONLY, and the tests below pin both halves: the new signal
// reorders, and the profile-derived clinical rule still hard-conflicts exactly as it does today.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveRecoNeedIntentSignals,
  classifyRecoCandidateAbrasion,
  applyRecoGentlenessPreference,
  resolveRecoGentlenessRankTier,
} = require('../src/auroraBff/recoGentlenessSignals');
const {
  resolveRecommendationTargetContext,
  finalizeRecommendationCandidatePools,
} = require('../src/auroraBff/recommendationSharedStack');

const GENTLE_NEED = 'a gentle exfoliant for sensitive skin under $40';
const USD40 = Object.freeze({ limit: 40, currency: 'USD' });

function product(product_id, name, price_amount) {
  return {
    product_id,
    merchant_id: 'm1',
    name,
    product_type: 'treatment',
    ...(price_amount == null ? {} : { price_amount, currency: 'USD' }),
  };
}

// The founder's own pool: what came back, plus what was available and did not.
const ORDINARY = product('ord', 'The Ordinary Salicylic Acid 2% Solution', 5.16);
const NUXE = product('nuxe', 'NUXE Radiance Face Scrub', 29);
const TIRTIR = product('tirtir', 'TIRTIR Matcha Bubble Tea Scrub', 20);
const AXISY = product('axis', 'AXIS-Y PHA Resurfacing Glow Peel', 6);
const NATURIUM = product('nat', 'Naturium BHA 2% Liquid Exfoliant', 19);
const FOUNDER_POOL = [ORDINARY, NUXE, TIRTIR, AXISY, NATURIUM];

const ctxFor = (text) => resolveRecommendationTargetContext({ text, entryType: 'direct' });
const order = (rows) => rows.map((r) => r.product_id).join(',');
const viableOrder = (text, options = {}) =>
  order(
    finalizeRecommendationCandidatePools(FOUNDER_POOL, {
      targetContext: ctxFor(text),
      ...options,
    }).viable_candidate_pool,
  );

// Measured on origin/main in this worktree, with the same pool.
const BASELINE_ORDER = 'ord,nuxe,tirtir,axis,nat';

// ---------------------------------------------------------------------------
// 1. The founder's case
// ---------------------------------------------------------------------------

test("the founder's case: chemical exfoliants lead, scrubs land last, nothing dropped", () => {
  const state = finalizeRecommendationCandidatePools(FOUNDER_POOL, {
    targetContext: ctxFor(GENTLE_NEED),
    priceCeiling: USD40,
  });
  // Mutant killed: reverting the gentleness partition in finalizeRecommendationCandidatePools. The
  // shortlist would be ord,nuxe,tirtir again -- two scrubs for "gentle ... sensitive skin".
  assert.equal(order(state.selected_recommendations), 'ord,axis,nat');
  assert.equal(order(state.viable_candidate_pool), 'ord,axis,nat,nuxe,tirtir');
  // Mutant killed: implementing the preference as a filter. Nothing may be dropped -- the scrubs are
  // still there, just behind.
  assert.equal(state.viable_candidate_pool.length, FOUNDER_POOL.length);
  assert.equal(state.hard_reject_count, 0);
  assert.equal(state.gentleness_rank_applied, true);
  assert.deepEqual(state.abrasion_class_counts, { chemical_gentle: 3, physical: 2 });
});

test('a buyer who asks for a SCRUB still gets scrubs', () => {
  // Mutant killed: dropping the scrub_requested suppression. "a face scrub for dull skin" would
  // demote the very thing it asked for.
  assert.equal(viableOrder('a face scrub for dull skin'), BASELINE_ORDER);
  // Even when both signals are present, the explicit request wins.
  assert.equal(viableOrder('a gentle face scrub for sensitive skin'), BASELINE_ORDER);
});

test('no gentleness signal: ordering is byte-identical to today', () => {
  // Measured against origin/main in this worktree: identical strings for all three.
  // Mutant killed: applying the partition unconditionally. Every caller that never said "gentle" --
  // the entire chat lane included -- would silently re-rank.
  assert.equal(viableOrder('an exfoliant'), BASELINE_ORDER);
  assert.equal(viableOrder('an exfoliant', { priceCeiling: USD40 }), BASELINE_ORDER);
  assert.equal(viableOrder(''), BASELINE_ORDER);
});

test('a CN need reorders the same way', () => {
  // Mutant killed: an EN-only vocabulary. recoTargetStep.js already ships CN tokens for every step;
  // a CN-only ask would get the scrub-heavy ordering with nothing to show why.
  assert.equal(viableOrder('敏感肌温和去角质'), 'ord,axis,nat,nuxe,tirtir');
  assert.equal(viableOrder('温和的去角质产品'), 'ord,axis,nat,nuxe,tirtir');
});

// ---------------------------------------------------------------------------
// 2. THE TRAP: profile-derived clinical constraints are untouched
// ---------------------------------------------------------------------------

test('a PROFILE with high sensitivity still hard-conflicts strong actives, exactly as today', () => {
  const state = finalizeRecommendationCandidatePools(FOUNDER_POOL, {
    targetContext: ctxFor(GENTLE_NEED),
    recoContext: { task_hard_context: { sensitivity: 'high' } },
  });
  // Measured identical on origin/main. A user whose PROFILE says high sensitivity is still steered
  // off acids -- that is a clinical rule, and this PR must not soften it.
  // Mutant killed: routing the need-text signal into computeCandidateContextSignals' sensitivity, or
  // weakening the conflict rule to "rescue" the chemical items.
  assert.equal(state.hard_reject_count, 3);
  assert.equal(order(state.selected_recommendations), 'nuxe,tirtir');
});

test('the need-text signal NEVER creates a constraint conflict on its own', () => {
  const state = finalizeRecommendationCandidatePools(FOUNDER_POOL, {
    targetContext: ctxFor(GENTLE_NEED),
    priceCeiling: USD40,
  });
  // Mutant killed: deriving sensitivity:'high' from the need text. Every chemical exfoliant would be
  // hard-zeroed and the shortlist would fill with scrubs -- the reported defect, amplified. With no
  // profile there must be ZERO rejects however gentle the wording.
  assert.equal(state.hard_reject_count, 0);
  assert.equal(state.constraint_conflict, false);
  assert.equal(state.viable_candidate_count, FOUNDER_POOL.length);
});

// ---------------------------------------------------------------------------
// 3. Price stays the OUTER key
// ---------------------------------------------------------------------------

test('a gentle chemical OVER the ceiling never outranks a conforming scrub', () => {
  const overChemical = product('overchem', 'Gentle PHA Resurfacing Serum', 99);
  const cheapScrub = product('cheapscrub', 'Sugar Face Scrub', 10);
  const state = finalizeRecommendationCandidatePools([overChemical, cheapScrub], {
    targetContext: ctxFor(GENTLE_NEED),
    priceCeiling: USD40,
  });
  // Mutant killed: applying the gentleness partition AFTER the price partition, which would make
  // gentleness the outer key and put a $99 product ahead of a conforming one. The composition only
  // works because the price partition is stable and runs last.
  assert.equal(order(state.viable_candidate_pool), 'cheapscrub,overchem');
});

// ---------------------------------------------------------------------------
// 4. Need-text signal derivation
// ---------------------------------------------------------------------------

test('gentleness is read from the buyer words that mean it', () => {
  for (const text of [
    GENTLE_NEED, 'something mild please', 'a non-irritating exfoliant', 'for sensitive skin',
    'a soothing option', 'fragrance-free exfoliant', '温和', '敏感肌', '低刺激',
  ]) {
    assert.equal(deriveRecoNeedIntentSignals({ text }).gentleness_preferred, true, text);
  }
  // Mutant killed: an unanchored vocabulary. "gentleman" and "insensitive" must not read as gentleness.
  for (const text of ['an exfoliant', 'a gentleman\'s grooming kit', 'insensitively strong peel', '']) {
    assert.equal(deriveRecoNeedIntentSignals({ text }).gentleness_preferred, false, text);
  }
});

test('an explicit scrub request is detected separately from gentleness', () => {
  const scrub = deriveRecoNeedIntentSignals({ text: 'a face scrub for dull skin' });
  assert.equal(scrub.scrub_requested, true);
  assert.equal(scrub.gentleness_preferred, false);
  assert.equal(deriveRecoNeedIntentSignals({ text: '磨砂膏' }).scrub_requested, true);
  // Mutant killed: folding scrub_requested into gentleness, or reading it off the CANDIDATE instead
  // of the NEED -- the suppression has to be about what the buyer asked for.
  assert.equal(deriveRecoNeedIntentSignals({ text: GENTLE_NEED }).scrub_requested, false);
});

test('the signals read focus as well as message text', () => {
  // Mutant killed: reading only `text`. The direct lane carries the ask in `focus` and the chat lane
  // in `text`; a signal that only sees one is dark for half the callers.
  assert.equal(deriveRecoNeedIntentSignals({ focus: 'gentle exfoliant', text: '' }).gentleness_preferred, true);
  assert.equal(deriveRecoNeedIntentSignals({ focus: '', text: 'gentle exfoliant' }).gentleness_preferred, true);
  assert.equal(deriveRecoNeedIntentSignals({}).gentleness_preferred, false);
});

test('fragrance-free is detected as its own flag', () => {
  assert.equal(deriveRecoNeedIntentSignals({ text: 'fragrance free exfoliant' }).fragrance_free_preferred, true);
  assert.equal(deriveRecoNeedIntentSignals({ text: 'unscented' }).fragrance_free_preferred, true);
  assert.equal(deriveRecoNeedIntentSignals({ text: '无香精' }).fragrance_free_preferred, true);
  assert.equal(deriveRecoNeedIntentSignals({ text: GENTLE_NEED }).fragrance_free_preferred, false);
});

// ---------------------------------------------------------------------------
// 5. Abrasion classification
// ---------------------------------------------------------------------------

test('the abrasion classifier reads the founder\'s actual product titles', () => {
  const c = (name) => classifyRecoCandidateAbrasion({ name });
  assert.equal(c('The Ordinary Salicylic Acid 2% Solution'), 'chemical_gentle');
  assert.equal(c('Naturium BHA 2% Liquid Exfoliant'), 'chemical_gentle');
  assert.equal(c('COSRX AHA/BHA Clarifying Treatment Toner'), 'chemical_gentle');
  assert.equal(c('NUXE Radiance Face Scrub'), 'physical');
  assert.equal(c('TIRTIR Matcha Bubble Tea Scrub'), 'physical');
  // Mutant killed: keying "strong" on the word "peel". The catalog's own gentle PHA option is
  // literally named "...Resurfacing Glow Peel" -- a peel rule demotes the product this PR promotes.
  assert.equal(c('AXIS-Y PHA Resurfacing Glow Peel'), 'chemical_gentle');
});

test('a high-concentration acid gets NO gentleness promotion', () => {
  // Mutant killed: removing the percentage gradient. A 30% peel is not what "gentle" asks for, but it
  // must be NEUTRAL, not demoted -- it is still a chemical exfoliant, not an abrasive.
  assert.equal(classifyRecoCandidateAbrasion({ name: 'AHA 30% + BHA 2% Peeling Solution' }), 'chemical_strong');
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Glycolic Acid 10% Toner' }), 'chemical_strong');
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Glycolic Acid 7% Toning Solution' }), 'chemical_gentle');
  const signals = { gentleness_preferred: true, scrub_requested: false };
  assert.equal(resolveRecoGentlenessRankTier({ name: 'AHA 30% + BHA 2% Peeling Solution' }, signals), 1);
  assert.equal(resolveRecoGentlenessRankTier({ name: 'The Ordinary Salicylic Acid 2%' }, signals), 0);
  assert.equal(resolveRecoGentlenessRankTier({ name: 'NUXE Radiance Face Scrub' }, signals), 2);
});

test('an abrasive wins over a chemical marker on the same product', () => {
  // Mutant killed: checking chemical before physical. An "Enzyme Scrub" is still something you rub on
  // your face; the enzyme does not make it gentle.
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Papaya Enzyme Scrub' }), 'physical');
  assert.equal(classifyRecoCandidateAbrasion({ name: 'AHA Sugar Scrub' }), 'physical');
});

test('an UNKNOWN candidate is neutral: no bonus, no penalty', () => {
  const unknown = product('unk', 'Hydrating Ceramide Treatment', 15);
  assert.equal(classifyRecoCandidateAbrasion(unknown), 'unknown');
  assert.equal(classifyRecoCandidateAbrasion({}), 'unknown');
  assert.equal(classifyRecoCandidateAbrasion(null), 'unknown');
  const signals = { gentleness_preferred: true, scrub_requested: false };
  // Mutant killed: demoting unknowns. MOST of the catalog says nothing about how it exfoliates, so a
  // penalty here is a silent global re-rank dressed up as a gentleness fix.
  assert.equal(resolveRecoGentlenessRankTier(unknown, signals), 1);
  const chemical = product('c', 'Lactic Acid 5%', 12);
  const scrub = product('s', 'Sugar Scrub', 12);
  assert.equal(
    order(applyRecoGentlenessPreference([scrub, unknown, chemical], signals)),
    'c,unk,s',
    'chemical > unknown > physical',
  );
});

test('"polishing" is not "polish"', () => {
  // Mutant killed: an unanchored /polish/ pattern -- "Polishing Serum" and "Nail Polish Remover"
  // would both read as abrasive.
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Polishing Vitamin C Serum' }), 'unknown');
  assert.equal(classifyRecoCandidateAbrasion({ name: 'Body Polish' }), 'physical');
});

test('the partition is stable and returns a copy', () => {
  const signals = { gentleness_preferred: true, scrub_requested: false };
  const a = product('a', 'Lactic Acid 5%', 1);
  const b = product('b', 'Mandelic Acid 5%', 2);
  const rows = [b, a];
  // Mutant killed: sorting inside a tier. Relevance order is the ranking the lane already computed;
  // this may only move rows BETWEEN tiers.
  assert.equal(order(applyRecoGentlenessPreference(rows, signals)), 'b,a');
  assert.notEqual(applyRecoGentlenessPreference(rows, signals), rows);
  assert.equal(order(applyRecoGentlenessPreference(rows, null)), 'b,a');
});

test('targetContext carries the signals so no new plumbing is needed', () => {
  const ctx = ctxFor(GENTLE_NEED);
  // Mutant killed: dropping need_intent_signals from resolveRecommendationTargetContext. targetContext
  // is already threaded to every finalizer; deriving the signal anywhere else would need the raw need
  // text plumbed through four more functions.
  assert.equal(ctx.need_intent_signals.gentleness_preferred, true);
  assert.equal(ctx.need_intent_signals.scrub_requested, false);
  assert.equal(ctxFor('an exfoliant').need_intent_signals.gentleness_preferred, false);
});

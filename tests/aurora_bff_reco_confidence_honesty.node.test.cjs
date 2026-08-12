'use strict';
/**
 * Invented-confidence honesty (fabrication-belt F4 follow-up, 2026-08-11).
 *
 * PR #1955 made the verified-candidate restore emit null instead of an
 * invented 0.61. Its review found three more writers of the same class:
 *   - beautyChatMainlineEnvelope: 0.61 fallback when basePayload had no score
 *   - beautyChatMainlineEntry: hard-coded 0.61 in the hard-path basePayload
 *   - legacyChatRecoEarlyExits: 0.62 fallback for travel confidence
 * All three now emit null for an uncomputed score. The readers in routes.js
 * (envelopeRequiresConservativeRecoGuard, the conservative-fallback confidence
 * picker) are null-guarded so Number(null) === 0 cannot turn an ABSENT score
 * into an explicit rock-bottom one.
 *
 * Same class, pre-existing: buildConfidenceNoticeCardPayload stamped the
 * client-visible confidence_notice card with score: 0 whenever the incoming
 * node had a null score or no score at all. The Aurora client reads only
 * severity/message/details/actions from this payload, so null is contract-safe.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_PRODUCT_GROUNDING_STABLE_ALIAS_PATH = path.join(
  __dirname,
  'fixtures',
  'product_grounding_stable_aliases.test.json',
);

const fs = require('node:fs');

const { createLegacyChatRecoEarlyExitsRuntime } = require('../src/auroraBff/legacyChatRecoEarlyExits');
const { __internal } = require('../src/auroraBff/routes');

const MAINLINE_OWNER = 'shopping_agent_beauty_mainline';

function canonicalHandoff() {
  return {
    searchResult: {
      decision_owner: MAINLINE_OWNER,
      semantic_owner: MAINLINE_OWNER,
      contract_bridge: { resolved_contract: 'agent_v1_search_beauty_mainline' },
      final_selection: {
        selection_owner: MAINLINE_OWNER,
        selected_product_ids: ['prod_1'],
        selected_titles: ['Test Serum'],
        source_tier_counts: { catalog: 1 },
      },
      source_breakdown: { source_tier_counts: { catalog: 1 } },
    },
    recommendations: [{ product_id: 'prod_1', title: 'Test Serum' }],
  };
}

function buildMainlinePayload(basePayload) {
  const out = __internal.buildRecoPayloadFromBeautyMainlineHandoff({
    handoff: canonicalHandoff(),
    profile: {},
    targetContext: null,
    recoContext: null,
    taskMode: 'goal_based_products',
    triggerSource: 'chat',
    sourceMode: 'step_aware_mainline',
    basePayload,
  });
  assert.ok(out && out.payload, 'canonical handoff must produce a payload');
  return out.payload;
}

test('beauty mainline envelope: no basePayload score -> null, never an invented 0.61', () => {
  const payload = buildMainlinePayload(null);
  assert.equal(payload.recommendation_confidence_score, null);
  assert.equal(payload.recommendation_confidence_level, 'medium');
});

test('beauty mainline envelope: an incoming null score stays null (Number(null) === 0 trap)', () => {
  // This is exactly what the entry hard path now passes in its basePayload.
  const payload = buildMainlinePayload({
    recommendation_confidence_score: null,
    recommendation_confidence_level: 'medium',
  });
  assert.equal(payload.recommendation_confidence_score, null);
});

test('beauty mainline envelope: a real computed score is preserved verbatim', () => {
  const payload = buildMainlinePayload({ recommendation_confidence_score: 0.87 });
  assert.equal(payload.recommendation_confidence_score, 0.87);
});

function travelRuntime() {
  return createLegacyChatRecoEarlyExitsRuntime({
    buildEnvelope: (ctx, body) => body,
    makeAssistantMessage: (text) => ({ text }),
    makeEvent: (ctx, eventName, data) => ({ event_name: eventName, data }),
    buildConfidenceNoticeCardPayload: (input) => input,
    summarizeProfileForContext: (profile) => profile || {},
    appendLatestRecoContextToSessionPatch: () => {},
  });
}

function buildTravelPayload(confidence) {
  const envelope = travelRuntime().maybeBuildLegacyTravelRecoEnvelope({
    ctx: { request_id: 'req_travel_1', lang: 'EN' },
    travelRecoHandoff: true,
    travelSkillsContracts: {
      __internal: {
        buildRecoPreview: () => ({
          recommendations: [{ title: 'Travel SPF', step: 'sunscreen' }],
          confidence,
        }),
      },
    },
    travelRecoContext: {
      travel_readiness: { env_source: 'itinerary' },
      destination: 'Tokyo',
    },
    profile: {},
    recoTaskMode: 'goal_based_products',
  });
  const recoCard = (envelope.cards || []).find((card) => card.type === 'recommendations');
  assert.ok(recoCard, 'travel handoff must produce a recommendations card');
  return recoCard.payload;
}

test('travel early exit: uncomputed confidence -> null, never an invented 0.62', () => {
  const payload = buildTravelPayload(undefined);
  assert.equal(payload.recommendation_confidence_score, null);
  assert.equal(payload.recommendation_confidence_level, 'medium');
});

test('travel early exit: an incoming null score stays null (Number(null) === 0 trap)', () => {
  const payload = buildTravelPayload({ score: null, level: '' });
  assert.equal(payload.recommendation_confidence_score, null);
});

test('travel early exit: a real computed score is preserved verbatim', () => {
  const payload = buildTravelPayload({ score: 0.55, level: 'low' });
  assert.equal(payload.recommendation_confidence_score, 0.55);
  assert.equal(payload.recommendation_confidence_level, 'low');
});

test('guard reader: a null score does not masquerade as explicit confidence', () => {
  // With a null score, the card must fall through to its confidence node —
  // before the null guard, Number(null) === 0 counted as "explicit", the
  // low/medium checks both missed, and the low-confidence node was skipped.
  const requires = __internal.envelopeRequiresConservativeRecoGuard({
    cards: [
      {
        type: 'recommendations',
        payload: {
          recommendation_confidence_score: null,
          confidence: { level: 'low' },
          recommendations: [],
        },
      },
    ],
    events: [],
  });
  assert.equal(requires, true);
});

test('guard reader: a null score alone is not rock-bottom confidence', () => {
  const requires = __internal.envelopeRequiresConservativeRecoGuard({
    cards: [
      {
        type: 'recommendations',
        payload: { recommendation_confidence_score: null, recommendations: [] },
      },
    ],
    events: [],
  });
  assert.equal(requires, false);
});

test('conservative fallback notice: null score defers to the real confidence node, not a fabricated 0', () => {
  // All recommendations are treatment-like, so the guard filters everything
  // and appends a confidence notice. Before the null guard, Number(null) === 0
  // made the picker return a fabricated {score: 0} instead of the node below.
  const { envelope, applied, fallbackApplied } = __internal.applyLowOrMediumRecoGuardToEnvelope({
    envelope: {
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendation_confidence_score: null,
            confidence: { score: 0.55, level: 'low' },
            recommendations: [{ name: 'Retinol Treatment Serum', step: 'treatment' }],
          },
        },
      ],
      events: [],
    },
    ctx: { request_id: 'req_guard_1' },
    language: 'EN',
  });
  assert.equal(applied, true);
  assert.equal(fallbackApplied, true);
  const notice = (envelope.cards || []).find((card) => card.type === 'confidence_notice');
  assert.ok(notice, 'guard must append a confidence notice when all recommendations are filtered');
  assert.equal(notice.payload.confidence.score, 0.55);
});

test('confidence notice card: a null score stays null (Number(null) === 0 trap)', () => {
  const payload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'low_confidence',
    confidence: { score: null, level: 'low', rationale: ['photo_quality'] },
  });
  assert.equal(payload.confidence.score, null);
  assert.equal(payload.confidence.level, 'low');
});

test('confidence notice card: a level-only confidence node does not grow an invented score', () => {
  const payload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'weak_viable_pool',
    confidence: { level: 'medium' },
  });
  assert.equal(payload.confidence.score, null);
  assert.equal(payload.confidence.level, 'medium');
});

test('confidence notice card: no confidence node -> score null, conservative low level', () => {
  const payload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'artifact_missing',
  });
  assert.equal(payload.confidence.score, null);
  assert.equal(payload.confidence.level, 'low');
});

test('confidence notice card: a real computed score is preserved and still derives the level', () => {
  const payload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'low_confidence',
    confidence: { score: 0.55 },
  });
  assert.equal(payload.confidence.score, 0.55);
  assert.equal(payload.confidence.level, 'medium');
});

test('confidence notice card: an explicit computed 0 is a real value, not nulled', () => {
  const payload = __internal.buildConfidenceNoticeCardPayload({
    language: 'EN',
    reason: 'low_confidence',
    confidence: { score: 0, level: 'low' },
  });
  assert.equal(payload.confidence.score, 0);
});

test('no writer ships a numeric literal recommendation_confidence_score', () => {
  // Kills a revert of any of the fixed sites (including the entry hard path,
  // which is not reachable as a unit): an uncomputed score is null or a
  // computed expression, never an invented literal.
  //
  // The original form of this guard matched only `score: 0.62` and therefore
  // MISSED `score: cond ? x : 0.62` and `score: x || 0.62` — precisely the two
  // shapes the bug actually took. It now flags a numeric literal anywhere in
  // the assigning expression.
  const files = [
    'src/auroraBff/beautyChatMainlineEnvelope.js',
    'src/auroraBff/beautyChatMainlineEntry.js',
    'src/auroraBff/legacyChatRecoEarlyExits.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const line of source.split('\n')) {
      if (!/recommendation_confidence_score\s*:/.test(line)) continue;
      const expression = line.slice(line.indexOf('recommendation_confidence_score'));
      const literal = expression.match(/:\s*[^,;]*?\b\d+\.\d+/);
      assert.equal(literal, null, `${file} assigns a literal score: ${line.trim()}`);
    }
  }
});

test('guard regex itself catches every fallback shape the bug took', () => {
  // Mutation-check the guard above: a guard that misses the real bug shape is
  // worse than no guard, because it reads as coverage.
  const flags = (line) => {
    const expression = line.slice(line.indexOf('recommendation_confidence_score'));
    return expression.match(/:\s*[^,;]*?\b\d+\.\d+/) != null;
  };
  assert.equal(flags('  recommendation_confidence_score: 0.62,'), true, 'direct literal');
  assert.equal(flags('  recommendation_confidence_score: Number.isFinite(x) ? x : 0.62,'), true, 'ternary fallback');
  assert.equal(flags('  recommendation_confidence_score: x || 0.62,'), true, 'or-fallback');
  assert.equal(flags('  recommendation_confidence_score: travelConfidenceScore,'), false, 'honest passthrough');
  assert.equal(flags('  recommendation_confidence_score: null,'), false, 'honest null');
});

/* ---------------------------------------------------------------------------
 * Routine-fit dimensions (F4, pre-existing).
 *
 * validateRoutineFitStructuredPayload deliberately accepts a partial dimension
 * set (it returns ok:true plus partial_dimensions), so an unmeasured dimension
 * is a live path, not a defensive branch. It used to be stamped with 0.5 in the
 * card AND re-invented as 0.5 by collectRoutineFitLowDimensions, which sorts
 * ascending — so an axis nobody scored was reported to the user as the
 * routine's single weakest point, displacing a real low score.
 * ------------------------------------------------------------------------- */

const ROUTINE_FIT_BASE = {
  overall_fit: 'partial_match',
  fit_score: 0.8,
  summary: 'Routine is mostly fine.',
  highlights: ['good cleanser'],
  concerns: ['no spf'],
  next_questions: [],
};

function buildRoutineFitCard(dimensionScores) {
  const validated = __internal.validateRoutineFitStructuredPayload({
    ...ROUTINE_FIT_BASE,
    dimension_scores: dimensionScores,
  });
  assert.equal(validated.ok, true, 'fixture must be a payload the validator accepts');
  return __internal.buildRoutineFitSummaryCard(validated.value, 'req_fit_1').payload;
}

test('routine fit: an unmeasured dimension is omitted, not stamped with 0.5', () => {
  const payload = buildRoutineFitCard({
    ingredient_match: { score: 0.86, note: 'strong' },
    routine_completeness: { score: 0.9, note: 'complete' },
    sensitivity_safety: { score: 0.88, note: 'safe' },
    // conflict_risk was never measured
  });
  assert.equal(payload.dimension_scores.conflict_risk, undefined);
  assert.deepEqual(payload.unmeasured_dimensions, ['conflict_risk']);
  assert.equal(payload.dimension_scores.ingredient_match.score, 0.86);
});

test('routine fit: an unmeasured dimension no longer displaces the real lowest score', () => {
  const payload = buildRoutineFitCard({
    ingredient_match: { score: 0.86, note: 'strong' },
    routine_completeness: { score: 0.9, note: 'complete' },
    sensitivity_safety: { score: 0.88, note: 'safe' },
  });
  const low = __internal.collectRoutineFitLowDimensions(payload, { max: 2 });
  assert.deepEqual(low.map((item) => item.key), ['ingredient_match', 'sensitivity_safety']);
  // Before the fix this was [conflict_risk 50%, ingredient_match 86%] and the
  // user-facing prose led with a dimension that was never scored.
  assert.equal(low.some((item) => item.key === 'conflict_risk'), false);
});

test('routine fit: an explicitly null dimension score is unmeasured, not 0%', () => {
  const payload = buildRoutineFitCard({
    ingredient_match: { score: null, note: '' },
    routine_completeness: { score: 0.9, note: '' },
    conflict_risk: { score: 0.4, note: '' },
    sensitivity_safety: { score: 0.88, note: '' },
  });
  assert.deepEqual(payload.unmeasured_dimensions, ['ingredient_match']);
  const low = __internal.collectRoutineFitLowDimensions(payload, { max: 1 });
  assert.deepEqual(low.map((item) => item.key), ['conflict_risk']);
});

test('routine fit: a genuine 0 is a real measurement and survives', () => {
  const payload = buildRoutineFitCard({
    ingredient_match: { score: 0, note: 'nothing matched' },
    routine_completeness: { score: 0.9, note: '' },
    conflict_risk: { score: 0.4, note: '' },
    sensitivity_safety: { score: 0.88, note: '' },
  });
  assert.deepEqual(payload.unmeasured_dimensions, []);
  assert.equal(payload.dimension_scores.ingredient_match.score, 0);
  assert.deepEqual(
    __internal.collectRoutineFitLowDimensions(payload, { max: 1 }).map((i) => i.key),
    ['ingredient_match'],
  );
});

/* ---------------------------------------------------------------------------
 * Travel writer (F4, and the reason #1957's travel fix was unreachable).
 *
 * legacyChatRecoEarlyExits was taught to carry a null travel confidence, but
 * its upstream writer ALWAYS produced a finite score — buildRecoPreview
 * substituted 0.45/0.6 and productMatcherV1 blended in 0.45/0.62 — so the null
 * branch never executed in the live path and a fabricated number still shipped.
 * The unit tests above only passed because they mock buildRecoPreview with
 * shapes the real writer could not emit. These tests use the REAL writer.
 * ------------------------------------------------------------------------- */

const travelContracts = require('../src/auroraBff/travelSkills/contracts');
const { buildProductRecommendationsBundle } = require('../src/auroraBff/productMatcherV1');

test('travel writer: no grounded seed products -> null score, never 0.45', () => {
  const preview = travelContracts.__internal.buildRecoPreview({
    travelReadiness: { env_source: 'itinerary' },
    profile: {},
    language: 'EN',
  });
  assert.equal(preview.confidence.score, null);
  assert.equal(preview.confidence.level, 'low');
});

test('product matcher: no measured signal at all -> null score, never 0.45/0.62 blended', () => {
  const bundle = buildProductRecommendationsBundle({
    ingredientPlan: { targets: [], avoid: [], confidence: null },
    profile: {},
    language: 'EN',
    seedRecommendations: [],
  });
  assert.equal(bundle.confidence.score, null);
  assert.equal(bundle.confidence.level, 'low');
  assert.ok(bundle.confidence.rationale.includes('avg_slot_score_unmeasured'));
  assert.ok(bundle.confidence.rationale.includes('plan_confidence_unmeasured'));
});

test('product matcher: a lone measured plan confidence is reported as itself, not blended with an invented average', () => {
  const bundle = buildProductRecommendationsBundle({
    ingredientPlan: { targets: [], avoid: [], confidence: { score: 0.3, level: 'low' } },
    profile: {},
    language: 'EN',
    seedRecommendations: [],
  });
  assert.equal(bundle.confidence.score, 0.3);
  assert.ok(bundle.confidence.rationale.includes('plan_confidence_30'));
});

test('travel end to end: the REAL writer can now produce the null the reader was taught to carry', () => {
  // This is the anti-masking test. With the old writer this assertion was
  // unreachable: every live travel run produced a fabricated number.
  const runtime = createLegacyChatRecoEarlyExitsRuntime({
    buildEnvelope: (ctx, body) => body,
    makeAssistantMessage: (text) => ({ text }),
    makeEvent: (ctx, eventName, data) => ({ event_name: eventName, data }),
    buildConfidenceNoticeCardPayload: __internal.buildConfidenceNoticeCardPayload,
    summarizeProfileForContext: (profile) => profile || {},
    appendLatestRecoContextToSessionPatch: () => {},
  });
  const envelope = runtime.maybeBuildLegacyTravelRecoEnvelope({
    ctx: { request_id: 'req_travel_real', lang: 'EN' },
    travelRecoHandoff: true,
    travelSkillsContracts: travelContracts, // the real module, not a mock
    travelRecoContext: { travel_readiness: { env_source: 'itinerary' }, destination: 'Tokyo' },
    profile: {},
    recoTaskMode: 'goal_based_products',
  });
  const notice = (envelope.cards || []).find((card) => card.type === 'confidence_notice');
  assert.ok(notice, 'an empty travel preview must degrade to a confidence notice');
  assert.equal(notice.payload.confidence.score, null, 'was a hard-coded 0.28');
  assert.equal(notice.payload.confidence.level, 'low');
});

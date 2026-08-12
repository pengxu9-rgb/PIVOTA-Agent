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
process.env.AURORA_DIAG_ARTIFACT_RETENTION_DAYS = '0';
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
    const hits = findLiteralScoreAssignments(source);
    assert.deepEqual(hits, [], `${file} assigns a literal score: ${hits[0]}`);
  }
});

// The assigning expression can span lines — the ORIGINAL 0.61 bug was a
// multi-line ternary with the literal on its own continuation line, which a
// line-scoped scan waves through. Scan a window from the field name to the
// next object key instead.
function findLiteralScoreAssignments(source) {
  const lines = source.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/recommendation_confidence_score\s*:/.test(lines[i])) continue;
    const chunk = lines.slice(i, i + 6).join('\n');
    const fromField = chunk.slice(chunk.search(/recommendation_confidence_score\s*:/));
    const expression = fromField.split(/,\s*\n\s*[a-z_]+\s*:/)[0];
    if (/\b\d+\.\d+/.test(expression)) hits.push(lines[i].trim());
  }
  return hits;
}

test('guard regex itself catches every fallback shape the bug took', () => {
  // Mutation-check the guard above: a guard that misses the real bug shape is
  // worse than no guard, because it reads as coverage.
  const flags = (line) => findLiteralScoreAssignments(line).length > 0;
  assert.equal(flags('  recommendation_confidence_score: 0.62,'), true, 'direct literal');
  assert.equal(flags('  recommendation_confidence_score: Number.isFinite(x) ? x : 0.62,'), true, 'ternary fallback');
  assert.equal(flags('  recommendation_confidence_score: x || 0.62,'), true, 'or-fallback');
  assert.equal(flags('  recommendation_confidence_score: travelConfidenceScore,'), false, 'honest passthrough');
  assert.equal(flags('  recommendation_confidence_score: null,'), false, 'honest null');
});

test('guard catches the ORIGINAL multi-line 0.61 shape (a verbatim revert)', () => {
  const preFixShape = [
    '      recommendation_confidence_score: Number.isFinite(',
    '        Number(basePayload?.recommendation_confidence_score),',
    '      )',
    '        ? Number(basePayload.recommendation_confidence_score)',
    '        : 0.61,',
    '      recommendation_confidence_level:',
  ].join('\n');
  assert.equal(findLiteralScoreAssignments(preFixShape).length, 1, 'multi-line fallback must be flagged');
  const fixedShape = [
    '      recommendation_confidence_score:',
    '        basePayload?.recommendation_confidence_score != null &&',
    '        Number.isFinite(Number(basePayload.recommendation_confidence_score))',
    '          ? Number(basePayload.recommendation_confidence_score)',
    '          : null,',
    '      recommendation_confidence_level:',
  ].join('\n');
  assert.deepEqual(findLiteralScoreAssignments(fixedShape), [], 'the fixed multi-line shape must pass');
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

/* ---------------------------------------------------------------------------
 * Reader sweep for the null-scored matcher bundle (F4).
 *
 * Once productMatcherV1 can emit confidence.score = null, every reader that
 * coerces with Number() before checking != null turns that null into an
 * explicit 0. Two such readers existed: the async matcher-check telemetry log
 * in legacyChatRecoPostProcessing, and the artifact_matcher KB write's
 * overallConfidence in legacyChatRecoEnvelope (whose llm_primary sibling was
 * already guarded in #1955).
 * ------------------------------------------------------------------------- */

const { createLegacyChatRecoPostProcessingRuntime } = require('../src/auroraBff/legacyChatRecoPostProcessing');
const { createLegacyChatRecoEnvelopeRuntime } = require('../src/auroraBff/legacyChatRecoEnvelope');

async function runAsyncMatcherCheck(bundleConfidence) {
  const logged = [];
  const runtime = createLegacyChatRecoPostProcessingRuntime({
    normalizeRecoProductsEmptyReason: () => '',
    applyRecoWarningVisibilityContract: (payload) => ({ payload }),
    isTransientRecoUpstreamFailureCode: () => false,
    recordAuroraSkinFlowMetric: () => {},
    sanitizeRecoClientVisibleToken: (value) => String(value || ''),
    inferRecoSourceMode: () => '',
    mergeFieldMissing: (base) => base,
  });
  runtime.postProcessLegacyChatRecoResult({
    ctx: { request_id: 'req_pp_1', trace_id: 'trace_pp_1' },
    norm: {
      payload: {
        recommendations: [{ name: 'Serum X' }],
        source: 'llm_primary_v1',
        recommendation_meta: { source_mode: 'llm_primary' },
      },
      field_missing: [],
    },
    recoContract: { mainline_status: 'grounded_success' },
    productMatcherEnabled: true,
    latestArtifact: { artifact_id: 'artifact_1' },
    computeMatcherIfNeeded: () => ({
      matcherBundle: { confidence: bundleConfidence },
      matcherPayload: { recommendations: [] },
    }),
    logger: { info: (fields, msg) => logged.push({ fields, msg }) },
  });
  // The matcher check is scheduled on setImmediate; flush it.
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  const entry = logged.find((row) => String(row.msg || '').includes('matcher check finished asynchronously'));
  assert.ok(entry, 'async matcher check must log its completion');
  return entry.fields;
}

test('async matcher telemetry: a null bundle score logs null, not an explicit 0', async () => {
  const fields = await runAsyncMatcherCheck({ score: null, level: 'low' });
  assert.equal(fields.confidence, null);
});

test('async matcher telemetry: a real bundle score is logged verbatim', async () => {
  const fields = await runAsyncMatcherCheck({ score: 0.44, level: 'low' });
  assert.equal(fields.confidence, 0.44);
});

function runEnvelopeKbWrite({ matcherBundle, finalHasRecs = true, artifactConfidenceScore = null }) {
  const savedRuns = [];
  const runtime = createLegacyChatRecoEnvelopeRuntime({
    buildEnvelope: (ctx, body) => body,
    makeAssistantMessage: (text) => ({ text }),
    makeEvent: (ctx, eventName, data) => ({ event_name: eventName, data }),
    buildConfidenceNoticeCardPayload: __internal.buildConfidenceNoticeCardPayload,
    buildIngredientPlanCard: () => ({ card_id: 'plan', type: 'ingredient_plan', payload: {} }),
    appendLatestArtifactToSessionPatch: () => {},
    appendLatestRecoContextToSessionPatch: () => {},
    recordAuroraRecoKbWrite: () => {},
    saveRecoRun: (run) => {
      savedRuns.push(run);
      return Promise.resolve();
    },
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: () => ({}),
    normalizeRecoSourceDetail: (value) => value,
    deriveRecoEmptyReason: () => 'artifact_missing',
  });
  const envelope = runtime.buildLegacyChatRecoEnvelope({
    ctx: { request_id: 'req_env_1', trace_id: 'trace_env_1', lang: 'EN' },
    payload: { recommendations: [{ name: 'Serum X' }] },
    matcherFallbackUsed: Boolean(matcherBundle),
    productMatcherEnabled: Boolean(matcherBundle),
    matcherBundle,
    finalHasRecs,
    finalAssistantText: 'here you go',
    artifactConfidenceScore,
  });
  return { savedRuns, envelope };
}

test('artifact_matcher KB write: a null bundle score persists null overallConfidence, not 0', () => {
  const { savedRuns } = runEnvelopeKbWrite({
    matcherBundle: { confidence: { score: null, level: 'low' }, recommendations: [] },
  });
  assert.equal(savedRuns.length, 1);
  assert.equal(savedRuns[0].overallConfidence, null);
});

test('artifact_matcher KB write: a real bundle score persists verbatim', () => {
  const { savedRuns } = runEnvelopeKbWrite({
    matcherBundle: { confidence: { score: 0.72, level: 'medium' }, recommendations: [] },
  });
  assert.equal(savedRuns.length, 1);
  assert.equal(savedRuns[0].overallConfidence, 0.72);
});

test('reco-missing notice: no artifact score -> null, never an invented 0.35', () => {
  const { envelope } = runEnvelopeKbWrite({
    matcherBundle: null,
    finalHasRecs: false,
    artifactConfidenceScore: null,
  });
  const notice = (envelope.cards || []).find((card) => card.type === 'confidence_notice');
  assert.ok(notice, 'a rec-less envelope must degrade to a confidence notice');
  assert.equal(notice.payload.confidence.score, null);
  assert.equal(notice.payload.confidence.level, 'low');
});

test('reco-missing notice: a real artifact score is preserved verbatim', () => {
  const { envelope } = runEnvelopeKbWrite({
    matcherBundle: null,
    finalHasRecs: false,
    artifactConfidenceScore: 0.4,
  });
  const notice = (envelope.cards || []).find((card) => card.type === 'confidence_notice');
  assert.equal(notice.payload.confidence.score, 0.4);
});

test('travel context-missing notice: nothing scored -> null, never an invented 0.2', () => {
  const runtime = createLegacyChatRecoEarlyExitsRuntime({
    buildEnvelope: (ctx, body) => body,
    makeAssistantMessage: (text) => ({ text }),
    makeEvent: (ctx, eventName, data) => ({ event_name: eventName, data }),
    buildConfidenceNoticeCardPayload: __internal.buildConfidenceNoticeCardPayload,
    summarizeProfileForContext: (profile) => profile || {},
    appendLatestRecoContextToSessionPatch: () => {},
  });
  const envelope = runtime.maybeBuildLegacyTravelRecoEnvelope({
    ctx: { request_id: 'req_travel_ctx', lang: 'EN' },
    travelRecoHandoff: true,
    travelSkillsContracts: null, // no preview builder and no readiness context
    travelRecoContext: { destination: 'Tokyo' },
    profile: {},
    recoTaskMode: 'goal_based_products',
  });
  const notice = (envelope.cards || []).find((card) => card.type === 'confidence_notice');
  assert.ok(notice, 'a context-less travel handoff must degrade to a confidence notice');
  assert.equal(notice.payload.confidence.score, null, 'was a hard-coded 0.2');
  assert.equal(notice.payload.confidence.level, 'low');
});

/* ---------------------------------------------------------------------------
 * Remaining F4 sites from the 2026-08-12 belt sweep (all pre-existing).
 *
 *   - pdpProductIntel.buildRecommendationIntents: an edge with no x_score was
 *     given 0.55, which cleared the 0.4 threshold and reported an UNRANKED
 *     relationship as 'moderate' confidence in the public API.
 *   - normalizeProgressLlmOutput: `confidence` is optional in the LLM output,
 *     so an omitted one became a precise-looking midpoint 0.5 on the card.
 *   - mergePhotoFindingsIntoAnalysis: unmeasured finding/takeaway confidence
 *     became 0 / 0.5 / 0.55 depending on which of the three normalizers ran.
 *
 * In every case a genuine 0 is a real measurement and must survive.
 * ------------------------------------------------------------------------- */

const { buildRecommendationIntents } = require('../src/pdpProductIntel');

test('pdp intents: an unranked edge reports low confidence, not a 0.55-derived "moderate"', () => {
  const out = buildRecommendationIntents([
    { product_id: 'p_unranked', title: 'Unranked' }, // producer omits x_score
    { product_id: 'p_null', title: 'Null score', x_score: null },
  ]);
  assert.deepEqual(out.similar.map((i) => i.confidence), ['low', 'low']);
});

test('pdp intents: a real x_score still maps to its true confidence band', () => {
  const out = buildRecommendationIntents([
    { product_id: 'p_high', title: 'High', x_score: 0.82 },
    { product_id: 'p_mid', title: 'Mid', x_score: 0.5 },
    { product_id: 'p_low', title: 'Low', x_score: 0.1 },
  ]);
  assert.deepEqual(out.similar.map((i) => i.confidence), ['high', 'moderate', 'low']);
});

function progressRaw(extra) {
  return {
    overall_trend: 'improving',
    concern_deltas: [
      { concern_id: 'acne', direction: 'improved', magnitude: 'slight', note_en: 'Fewer breakouts', note_zh: '痘痘减少' },
    ],
    recommendation_en: 'Keep the current routine',
    recommendation_zh: '保持当前流程',
    ...extra,
  };
}

test('progress summary: an omitted LLM confidence stays null, never an invented 0.5', () => {
  assert.equal(__internal.normalizeProgressLlmOutput(progressRaw())?.confidence, null);
  assert.equal(__internal.normalizeProgressLlmOutput(progressRaw({ confidence: null }))?.confidence, null);
});

test('progress summary: a real confidence is preserved, including a genuine 0', () => {
  assert.equal(__internal.normalizeProgressLlmOutput(progressRaw({ confidence: 0.83 }))?.confidence, 0.83);
  assert.equal(__internal.normalizeProgressLlmOutput(progressRaw({ confidence: 0 }))?.confidence, 0);
});

test('progress card: an unmeasured confidence reaches the card as null, not 0', () => {
  const section = (raw) =>
    __internal
      .buildSkinProgressCard({
        ctx: { request_id: 'req_progress' },
        baseline: null,
        progress: __internal.normalizeProgressLlmOutput(raw),
        language: 'EN',
      })
      .payload.sections.find((s) => s.kind === 'progress_delta');
  assert.equal(section(progressRaw()).confidence, null);
  assert.equal(section(progressRaw({ confidence: 0.83 })).confidence, 0.83);
});

test('photo merge: unmeasured finding and takeaway confidence stay null, a genuine 0 survives', () => {
  const merged = __internal.mergePhotoFindingsIntoAnalysis({
    analysis: { findings: [], takeaways: [] },
    diagnosisV1: {
      photo_findings: [
        { issue_type: 'acne', text: 'a', confidence: 0.77 },
        { issue_type: 'redness', text: 'b' }, // never measured
        { issue_type: 'dryness', text: 'c', confidence: 0 }, // measured as zero
      ],
      takeaways: [
        { source: 'photo', issue_type: 'acne', text: 'Acne improving', confidence: 0.66 },
        { source: 'photo', issue_type: 'redness', text: 'Redness present' }, // never measured
      ],
    },
    language: 'EN',
    profileSummary: {},
  });
  const byIssue = (rows) => Object.fromEntries((rows || []).map((r) => [r.issue_type, r.confidence]));
  const findings = byIssue(merged.findings);
  assert.equal(findings.acne, 0.77);
  assert.equal(findings.redness, null, 'unmeasured must not become a confident 0');
  assert.equal(findings.dryness, 0, 'a measured zero is a real value');
  const takeaways = byIssue(merged.takeaways);
  assert.equal(takeaways.acne, 0.66);
  assert.equal(takeaways.redness, null);
});

test('concern confidence: nothing measured -> null, neither a 0 nor an invented 0.58', () => {
  const unmeasured = __internal.deriveConcernConfidence({
    issueType: 'acne',
    analysis: { findings: [{ issue_type: 'acne', confidence: null }] },
    defaultScore: null,
  });
  assert.equal(unmeasured, null);
  const measured = __internal.deriveConcernConfidence({
    issueType: 'acne',
    analysis: { findings: [{ issue_type: 'acne', confidence: 0.7 }] },
    defaultScore: null,
  });
  assert.equal(measured, 0.7);
});

test('artifact confidence: a null score yields no score and a conservative level', () => {
  assert.deepEqual(__internal.buildArtifactConfidence(null, ['r']), {
    score: null,
    level: 'low',
    rationale: ['r'],
  });
  assert.equal(__internal.buildArtifactConfidence(0.8, ['r']).score, 0.8);
  assert.equal(__internal.buildArtifactConfidence(0, ['r']).score, 0, 'a measured zero survives');
});

/* ---------------------------------------------------------------------------
 * Review fixes (PR #1957 code review, 2026-08-12).
 *
 * The review found the null invariant defeated at three boundaries: the
 * persistence layer (toConfidenceScore read null as 0), the conservative
 * fallback picker (re-invented LOW_CONFIDENCE_THRESHOLD for level-only
 * cards), and the routine-fit sibling field fit_score (null->0, absent->0.5,
 * and a `|| 0.5` prose read that turned a genuine 0 into "50%"). Plus the
 * last invented notice literals in direct-reco/chat/travel-degraded paths.
 * ------------------------------------------------------------------------- */

const { saveRecoRun } = require('../src/auroraBff/diagnosisArtifactStore');
const { inferConfidenceScore } = require('../src/auroraBff/travelKbPolicy');

test('persistence: saveRecoRun keeps a null overallConfidence null in the stored row', async () => {
  const row = await saveRecoRun({ auroraUid: 'uid_test_1', overallConfidence: null });
  assert.equal(row.overall_confidence, null);
});

test('persistence: a real overallConfidence is stored verbatim and a genuine 0 stays 0', async () => {
  const real = await saveRecoRun({ auroraUid: 'uid_test_1', overallConfidence: 0.72 });
  assert.equal(real.overall_confidence, 0.72);
  const zero = await saveRecoRun({ auroraUid: 'uid_test_1', overallConfidence: 0 });
  assert.equal(zero.overall_confidence, 0);
});

test('conservative fallback picker: a level-only card no longer grows an invented 0.55', () => {
  const { envelope, applied, fallbackApplied } = __internal.applyLowOrMediumRecoGuardToEnvelope({
    envelope: {
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendation_confidence_score: null,
            recommendation_confidence_level: 'medium',
            recommendations: [{ name: 'Retinol Treatment Serum', step: 'treatment' }],
          },
        },
      ],
      events: [],
    },
    ctx: { request_id: 'req_guard_2' },
    language: 'EN',
  });
  assert.equal(applied, true);
  assert.equal(fallbackApplied, true);
  const notice = (envelope.cards || []).find((card) => card.type === 'confidence_notice');
  assert.ok(notice, 'guard must append a confidence notice');
  assert.equal(notice.payload.confidence.score, null, 'was an invented LOW_CONFIDENCE_THRESHOLD');
  assert.equal(notice.payload.confidence.level, 'medium');
});

test('routine fit: a null or absent fit_score is unmeasured, not 0% or an invented 50%', () => {
  const nulled = __internal.buildRoutineFitSummaryCard(
    { overall_fit: 'partial_match', fit_score: null, dimension_scores: {} },
    'req_fit_2',
  ).payload;
  assert.equal(nulled.fit_score, null);
  const absent = __internal.buildRoutineFitSummaryCard(
    { overall_fit: 'partial_match', dimension_scores: {} },
    'req_fit_3',
  ).payload;
  assert.equal(absent.fit_score, null);
});

test('routine fit: a genuine fit_score of 0 is a real measurement', () => {
  const payload = __internal.buildRoutineFitSummaryCard(
    { overall_fit: 'needs_adjustment', fit_score: 0, dimension_scores: {} },
    'req_fit_4',
  ).payload;
  assert.equal(payload.fit_score, 0);
});

test('prefix prose: unmeasured fit renders without a percentage; a genuine 0 renders 0%, not 50%', () => {
  const prose = (fitScore) => __internal.buildSkinAnalysisContextForPrefix({
    lastAnalysis: {
      routine_fit: { overall_fit: 'partial_match', fit_score: fitScore, dimension_scores: {} },
    },
  }) || '';
  const unmeasured = prose(null);
  assert.match(unmeasured, /Routine fit: partial_match(?!\s*\()/);
  assert.doesNotMatch(unmeasured, /Routine fit: [^\n]*%/);
  assert.match(prose(0), /Routine fit: partial_match \(0%\)/);
  assert.match(prose(0.8), /Routine fit: partial_match \(80%\)/);
});

test('travel KB policy: a null readiness score falls through to the level, not to 0', () => {
  assert.equal(inferConfidenceScore({ score: null, level: 'low' }), 0.5);
  assert.equal(inferConfidenceScore({ score: 0, level: 'low' }), 0);
  assert.equal(inferConfidenceScore({ score: 0.8, level: 'low' }), 0.8);
});

test('no touched notice writer ships a literal confidence score', () => {
  // The direct-reco 0.35 twins, chat's 0.2, and the degraded-readiness 0.35
  // were character-for-character the literals the earlier commits nulled.
  const files = [
    'src/auroraBff/directRecoGenerateHandler.js',
    'src/auroraBff/routes/chat.js',
    'src/auroraBff/travelSkills/contracts.js',
    'src/auroraBff/legacyChatRecoEarlyExits.js',
    'src/auroraBff/legacyChatRecoEnvelope.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const literal = source.match(/confidence:\s*\{[^}]{0,160}?score:\s*\d+\.\d+/);
    assert.equal(literal, null, `${file} ships a literal notice score: ${literal && literal[0]}`);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  parseCards,
  findCard,
} = require('./aurora_bff_test_harness.cjs');
const { __internal: routesInternal } = require('../src/auroraBff/routes');
const {
  adjudicateReportCanonicalLayer,
  adjudicateDeepeningCanonicalLayer,
  renderReportCanonicalLayer,
  renderDeepeningCanonicalLayer,
} = require('../src/auroraBff/skinAnalysisContract');

function currentAnalysisCardFromBody(body) {
  const cards = parseCards(body);
  return findCard(cards, 'analysis_story_v2') || findCard(cards, 'analysis_summary');
}

function countUploadPhotoChips(body) {
  const chips = Array.isArray(body && body.suggested_chips) ? body.suggested_chips : [];
  return chips.filter((chip) => {
    const id = String(chip && chip.chip_id || '').trim().toLowerCase();
    return id === 'chip.intake.upload_photos' || id === 'chip_intake_upload_photos';
  }).length;
}

function renderDeepeningFromPlan(plan, { lang = 'en-US' } = {}) {
  const canonical = adjudicateDeepeningCanonicalLayer(
    {
      phase: plan && plan.phasePlan ? plan.phasePlan.phase : 'photo_optin',
      question_intent: plan && plan.dto ? plan.dto.question_intent : 'photo_upload',
    },
    {
      inheritedPriority: plan && plan.dto ? plan.dto.summary_priority : 'mixed',
      deepeningContext: plan && plan.dto ? plan.dto : null,
    },
  );
  return renderDeepeningCanonicalLayer(canonical, { lang });
}

function buildReportSuccessStub({ lang = 'en-US', priority = 'barrier' } = {}) {
  const canonical = adjudicateReportCanonicalLayer(
    {
      needs_risk_check: true,
      summary_focus: { priority, primary_cues: priority === 'barrier' ? ['redness', 'texture'] : [priority] },
      insights: [
        {
          cue: 'redness',
          region: 'cheeks',
          severity: 'moderate',
          confidence: 'high',
          evidence: 'cheek redness',
        },
      ],
      routine_steps: [
        {
          time: 'am',
          step_type: 'cleanse',
          target: 'barrier',
          cadence: 'daily',
          intensity: 'gentle',
          linked_cues: ['redness'],
        },
      ],
      watchouts: ['pause_if_stinging'],
      follow_up: { intent: 'reaction_check', conditional_followups: ['routine_share'] },
      two_week_focus: ['stabilize_barrier'],
      risk_flags: [],
    },
    {
      reportContext: {
        concern_rank: ['redness', 'texture'],
        deterministic_signals: {
          redness: 'mid',
          oiliness: 'low',
          acne_like: 'few',
          dryness: 'some',
          texture: 'rough',
        },
        routine_summary: { moisturizer: 'yes', sunscreen: 'unknown', actives: ['retinoid'] },
        constraints: ['sensitive-skin self-report'],
        vision_cues: [{ cue: 'redness', region: 'cheeks', severity: 'moderate', confidence: 'high' }],
        quality: { grade: 'pass' },
      },
    },
  );
  return {
    ok: true,
    provider: 'gemini',
    reason: null,
    schema_violation: false,
    semantic_violation: false,
    layer: renderReportCanonicalLayer(canonical, { lang, quality: { grade: 'pass' } }),
    canonical,
    semantic: { ok: true, useful_output: true, issues: [] },
    retry: { attempted: 0, final: 'success', last_reason: null },
    prompt_version: 'skin_v3',
  };
}

test('skin deepening compatibility: current analysis card accessor supports story_v2 and legacy summary envelopes', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_RESPONSE_FORMAT: 'legacy',
      AURORA_SKIN_SINGLE_CARD_V1: 'true',
      AURORA_SKIN_DEEPENING_V1: 'true',
      AURORA_CHATCARDS_SESSION_PATCH_V1: 'true',
      AURORA_CARD_FIRST_DEDUPE_V1: 'true',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat();
      try {
        const uid = buildTestUid('skin_deepening_story');
        const initial = await request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({ use_photo: false })
          .expect(200);

        const currentCard = currentAnalysisCardFromBody(initial.body);
        assert.ok(currentCard, 'current analysis card should exist');
        assert.equal(currentCard.type, 'analysis_story_v2');
        assert.equal(Boolean(findCard(parseCards(initial.body), 'analysis_summary')), false);
        assert.equal(countUploadPhotoChips(initial.body), 1);
      } finally {
        restore();
      }
    },
  );

  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_RESPONSE_FORMAT: 'legacy',
      AURORA_SKIN_SINGLE_CARD_V1: 'true',
      AURORA_SKIN_DEEPENING_V1: 'true',
      AURORA_CHATCARDS_SESSION_PATCH_V1: 'true',
      AURORA_CARD_FIRST_DEDUPE_V1: 'true',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'false',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat();
      try {
        const uid = buildTestUid('skin_deepening_summary');
        const initial = await request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({ use_photo: false })
          .expect(200);

        const currentCard = currentAnalysisCardFromBody(initial.body);
        assert.ok(currentCard, 'legacy-compatible analysis card should exist');
        assert.equal(currentCard.type, 'analysis_summary');
        assert.equal(Boolean(findCard(parseCards(initial.body), 'analysis_story_v2')), false);
        assert.equal(currentCard.payload.analysis.insufficient_visual_detail, true);
      } finally {
        restore();
      }
    },
  );
});

test('skin deepening compatibility: mainline phase planner and renderer stay deterministic across photo_optin -> refined', () => {
  const reportCanonical = {
    summary_focus: { priority: 'barrier' },
    watchouts: ['pause_if_stinging'],
    two_week_focus: ['confirm_tolerance'],
    insights: [{ cue: 'redness', region: 'cheeks', severity: 'mild', confidence: 'med', evidence: 'diffuse cheek redness' }],
  };

  const photoOptin = routesInternal.buildMainlineDeepeningDto({
    language: 'en-US',
    promptVersion: 'skin_v3',
    userRequestedPhoto: true,
    photosProvided: false,
    hasRoutine: false,
    routineCandidate: null,
    profileSummary: { goals: ['calm redness'] },
    recentLogsSummary: [],
    qualityObject: { grade: 'pass' },
    reportCanonical,
    visionCanonical: null,
  });
  const photoOptinRendered = renderDeepeningFromPlan(photoOptin, { lang: 'en-US' });
  assert.equal(photoOptin.phasePlan.phase, 'photo_optin');
  assert.equal(photoOptinRendered.phase, 'photo_optin');
  assert.match(photoOptinRendered.question, /upload/i);
  assert.deepEqual(photoOptinRendered.options, ['Upload photo', 'Skip for now']);
  assert.equal(new Set(photoOptinRendered.options).size, photoOptinRendered.options.length);

  const products = routesInternal.buildMainlineDeepeningDto({
    language: 'en-US',
    promptVersion: 'skin_v3',
    userRequestedPhoto: true,
    photosProvided: true,
    hasRoutine: false,
    routineCandidate: null,
    profileSummary: { goals: ['calm redness'] },
    recentLogsSummary: [],
    qualityObject: { grade: 'pass' },
    reportCanonical,
    visionCanonical: null,
  });
  const productsRendered = renderDeepeningFromPlan(products, { lang: 'en-US' });
  assert.equal(products.phasePlan.phase, 'products');
  assert.equal(productsRendered.phase, 'products');
  assert.deepEqual(productsRendered.options, ['Share AM routine', 'Share PM routine', 'Not sure']);

  const reactions = routesInternal.buildMainlineDeepeningDto({
    language: 'en-US',
    promptVersion: 'skin_v3',
    userRequestedPhoto: true,
    photosProvided: true,
    hasRoutine: true,
    routineCandidate: 'retinoid pm',
    profileSummary: { goals: ['calm redness'] },
    recentLogsSummary: [{ reaction: 'stinging after serum' }],
    qualityObject: { grade: 'pass' },
    reportCanonical,
    visionCanonical: null,
  });
  const reactionsRendered = renderDeepeningFromPlan(reactions, { lang: 'en-US' });
  assert.equal(reactions.phasePlan.phase, 'reactions');
  assert.equal(reactionsRendered.phase, 'reactions');
  assert.deepEqual(
    reactionsRendered.options,
    ['More dryness', 'Tightness', 'Stinging/burning', 'More redness', 'New breakouts', 'No obvious discomfort'],
  );

  const refined = routesInternal.buildMainlineDeepeningDto({
    language: 'en-US',
    promptVersion: 'skin_v3',
    userRequestedPhoto: true,
    photosProvided: true,
    hasRoutine: true,
    routineCandidate: 'cleanser moisturizer spf',
    profileSummary: { goals: ['calm redness'] },
    recentLogsSummary: [],
    qualityObject: { grade: 'pass' },
    reportCanonical,
    visionCanonical: null,
  });
  const refinedRendered = renderDeepeningFromPlan(refined, { lang: 'en-US' });
  assert.equal(refined.phasePlan.phase, 'refined');
  assert.equal(refinedRendered.phase, 'refined');
  assert.match(refinedRendered.question, /7-day plan/i);
  assert.deepEqual(
    refinedRendered.options,
    ['I can follow it for 7 days', 'I need a simpler version', 'I also want product optimization'],
  );
});

test('skin deepening compatibility: legacy single-card fallback keeps a renderable summary without duplicate upload prompts', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_CHAT_RESPONSE_FORMAT: 'legacy',
      AURORA_SKIN_SINGLE_CARD_V1: 'true',
      AURORA_SKIN_DEEPENING_V1: 'true',
      AURORA_CHATCARDS_SESSION_PATCH_V1: 'true',
      AURORA_CARD_FIRST_DEDUPE_V1: 'true',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'false',
      AURORA_SKIN_DEEPENING_LLM_V1: 'true',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      AURORA_VISION_GEMINI_API_KEY: '',
      AURORA_SKIN_GEMINI_API_KEY: '',
    },
    async () => {
      const { request, restore } = createAppWithPatchedAuroraChat();
      try {
        const uid = buildTestUid('skin_deepening_fallback');
        const initial = await request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({ use_photo: false })
          .expect(200);

        const summaryCard = findCard(parseCards(initial.body), 'analysis_summary');
        assert.ok(summaryCard, 'analysis_summary should exist in legacy single-card fallback mode');
        assert.equal(summaryCard.payload.analysis.insufficient_visual_detail, true);
        assert.match(String(summaryCard.payload.analysis.strategy || ''), /Retake guide|Meanwhile plan/i);
        assert.equal(countUploadPhotoChips(initial.body) <= 1, true);
      } finally {
        restore();
      }
    },
  );
});

test('skin deepening compatibility: report optional step failures fail open to deterministic baseline', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_SKIN_GEMINI_API_KEY: 'test-key',
      GEMINI_API_KEY: 'test-key',
      GOOGLE_API_KEY: 'test-key',
    },
    async () => {
      const { request, restore, routesMod } = createAppWithPatchedAuroraChat();
      try {
        routesMod.__internal.__setSkinLlmStrategyRunnersForTest({
          report: async () => {
            throw new Error('report_lifecycle_context_blowup');
          },
        });
        const uid = buildTestUid('skin_report_optional_fail_open');
        const resp = await request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: 'AM cleanser + SPF; PM retinoid + moisturizer',
          })
          .expect(200);

        const currentCard = currentAnalysisCardFromBody(resp.body);
        assert.ok(currentCard, 'analysis card should still exist');
        assert.match(JSON.stringify(currentCard.payload || {}), /analysis/i);
      } finally {
        routesMod.__internal.__resetSkinLlmStrategyRunnersForTest();
        restore();
      }
    },
  );
});

test('skin deepening compatibility: deepening optional step failures fall back to deterministic deepening', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_SKIN_GEMINI_API_KEY: 'test-key',
      GEMINI_API_KEY: 'test-key',
      GOOGLE_API_KEY: 'test-key',
    },
    async () => {
      const { request, restore, routesMod } = createAppWithPatchedAuroraChat();
      try {
        routesMod.__internal.__setSkinLlmStrategyRunnersForTest({
          report: async () => buildReportSuccessStub({ lang: 'en-US' }),
          deepening: async () => {
            throw new Error('deepening_optional_child_blowup');
          },
        });
        const uid = buildTestUid('skin_deepening_optional_fail_open');
        const resp = await request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: 'AM cleanser + SPF; PM retinoid + moisturizer',
            recentLogs: [{ reaction: 'stinging after serum' }],
          })
          .expect(200);

        const currentCard = currentAnalysisCardFromBody(resp.body);
        assert.ok(currentCard, 'analysis card should still exist');
        const cards = parseCards(resp.body);
        assert.equal(Boolean(findCard(cards, 'error')), false);
      } finally {
        routesMod.__internal.__resetSkinLlmStrategyRunnersForTest();
        restore();
      }
    },
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { resetVisionMetrics, snapshotVisionMetrics } = require('../src/auroraBff/visionMetrics');

const {
  sleep,
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  parseCards,
  findCard,
} = require('./aurora_bff_test_harness.cjs');
const {
  adjudicateReportCanonicalLayer,
  renderReportCanonicalLayer,
} = require('../src/auroraBff/skinAnalysisContract');

function getLabeledCounterValue(entries, expectedLabels) {
  const rows = Array.isArray(entries) ? entries : [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const [key, value] = row;
    let labels = null;
    try {
      labels = JSON.parse(key);
    } catch (_err) {
      labels = null;
    }
    if (!labels || typeof labels !== 'object') continue;
    let matched = true;
    for (const [k, v] of Object.entries(expectedLabels || {})) {
      if (String(labels[k]) !== String(v)) {
        matched = false;
        break;
      }
    }
    if (matched) return Number(value) || 0;
  }
  return 0;
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

test('/v1/chat routine: timeout degrades to confidence_notice(timeout_degraded) with routine recovery chips', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_BFF_CHAT_ROUTINE_V2_ENABLED: 'true',
      AURORA_BFF_CHAT_ROUTINE_BUDGET_MS: '1000',
      AURORA_BFF_RECO_ROUTINE_TIMEOUT_MS: '8000',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => {
        await sleep(1600);
        return {
          answer: '{}',
          intent: 'chat',
          recommendations: [
            {
              step: 'Moisturizer',
              slot: 'pm',
              category: 'moisturizer',
              sku: { sku_id: 'sku_timeout_1', name: 'Timeout Cream' },
            },
          ],
        };
      });

      try {
        const uid = buildTestUid('routine_timeout');
        const resp = await harness.request
          .post('/v1/chat')
          .set(headersFor(uid, 'EN'))
          .send({
            action: {
              action_id: 'chip.start.routine',
              kind: 'chip',
              data: {
                reply_text: 'Build an AM/PM routine',
                profile_patch: {
                  skinType: 'oily',
                  sensitivity: 'low',
                  barrierStatus: 'healthy',
                  goals: ['pores'],
                },
              },
            },
            session: { state: 'S2_DIAGNOSIS' },
            language: 'EN',
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const notice = findCard(cards, 'confidence_notice');
        assert.ok(notice, 'confidence_notice should exist');
        assert.equal(notice.payload && notice.payload.reason, 'timeout_degraded');

        const chips = Array.isArray(resp.body && resp.body.suggested_chips) ? resp.body.suggested_chips : [];
        const chipIds = chips.map((c) => String(c && c.chip_id ? c.chip_id : ''));
        assert.ok(chipIds.includes('chip.intake.paste_routine'));
        assert.ok(chipIds.includes('chip.start.routine'));
        assert.equal(Boolean(findCard(cards, 'recommendations')), false);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: returns routine_expert contract when routine intake is provided', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'false',
      AURORA_ROUTINE_EXPERT_HARDSTOP_ENABLED: 'true',
      AURORA_ROUTINE_EVIDENCE_REFS_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_expert_contract');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Biotherm Force Cleanser',
                moisturizer: 'Aquasource Hydra Barrier Cream',
              },
              pm: {
                cleanser: 'Biotherm Force Cleanser',
                treatment: 'retinol serum',
                moisturizer: 'Aquasource Hydra Barrier Cream',
              },
              notes: 'Wash feels tight after cleansing; moisturizer stings for 45 seconds.',
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const analysisSummary = findCard(cards, 'analysis_summary');
        assert.ok(analysisSummary, 'analysis_summary should exist');

        const expert =
          analysisSummary &&
          analysisSummary.payload &&
          analysisSummary.payload.analysis &&
          analysisSummary.payload.analysis.routine_expert
            ? analysisSummary.payload.analysis.routine_expert
            : null;
        assert.ok(expert, 'routine_expert should exist');
        assert.equal(expert.contract, 'aurora.routine_expert.v1');
        assert.ok(Array.isArray(expert.key_issues) && expert.key_issues.length > 0);
        assert.equal(String(expert.key_issues[0] && expert.key_issues[0].id), 'hard_stop_cleanser');
        assert.ok(expert.key_issues.some((item) => String(item && item.id) === 'moisturizer_stinging_threshold'));
        assert.ok(expert.plan_7d && Array.isArray(expert.plan_7d.am) && expert.plan_7d.am.length > 0);
        assert.ok(/stop|停用/i.test(String(expert.plan_7d.am[0] || '')));
        assert.ok(
          Array.isArray(expert.plan_7d.pm) &&
            expert.plan_7d.pm.some((line) => /gentle remover|温和卸除|暴力清洁/.test(String(line || ''))),
        );
        assert.ok(expert.phase_plan && Array.isArray(expert.phase_plan.phase_1_14d) && expert.phase_plan.phase_1_14d.length > 0);
        assert.ok(expert.phase_plan && Array.isArray(expert.phase_plan.phase_2_3_6w) && expert.phase_plan.phase_2_3_6w.length > 0);
        assert.ok(Array.isArray(expert.evidence_refs) && expert.evidence_refs.length > 0);
        assert.ok(
          expert.evidence_refs.some((item) =>
            ['biotherm_force_cleanser_micro_particles', 'cleanser_ph_barrier_review'].includes(String(item && item.id)),
          ),
        );
        assert.ok(typeof expert.primary_question === 'string' && expert.primary_question.trim().length > 0);
        assert.ok(Array.isArray(expert.conditional_followups));
        assert.ok(Array.isArray(expert.ask_3_questions) && expert.ask_3_questions.length === 3);
        assert.equal(expert.ask_3_questions[0], expert.primary_question);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: emits routine_products_preview and defers routine product enhancement from main path', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_PRODUCT_AUTOSCAN_ENABLED: 'true',
      AURORA_ROUTINE_PRODUCT_AUTOSCAN_SYNC_LIMIT: '4',
      AURORA_ROUTINE_PRODUCT_AUTOSCAN_TOTAL_LIMIT: '12',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_preview_contract');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              schema_version: 'aurora.routine_intake.v1',
              am: [
                { step: 'cleanser', product: 'Biotherm Force Cleanser' },
                { step: 'moisturizer', product: 'Aquasource Hydra Barrier Cream' },
              ],
              pm: [
                { step: 'cleanser', product: 'Biotherm Force Cleanser' },
                { step: 'treatment', product: 'Retinal serum' },
                { step: 'moisturizer', product: 'Aquasource Hydra Barrier Cream' },
              ],
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const analysisSummary = findCard(cards, 'analysis_summary') || findCard(cards, 'analysis_story_v2');
        const preview = findCard(cards, 'routine_products_preview');
        const productAnalysis = findCard(cards, 'product_analysis');
        const routineFitSummary = findCard(cards, 'routine_fit_summary');
        const suggestedChipIds = Array.isArray(resp.body && resp.body.suggested_chips)
          ? resp.body.suggested_chips.map((chip) => String(chip && chip.chip_id ? chip.chip_id : ''))
          : [];

        assert.ok(analysisSummary, 'analysis summary card should exist');
        assert.ok(preview, 'routine_products_preview should exist');
        assert.equal(productAnalysis, null, 'product_analysis should not be emitted on /v1/analysis/skin');
        assert.equal(routineFitSummary, null, 'routine_fit_summary should not be emitted in summary-first mode');
        assert.equal(preview.payload && preview.payload.contract, 'aurora.routine_products_preview.v1');
        assert.equal(preview.payload && preview.payload.deferred_product_enrichment, true);
        assert.ok(['structured_v1', 'structured_v2'].includes(preview.payload && preview.payload.payload_shape));
        assert.equal(preview.payload && preview.payload.counts && preview.payload.counts.total > 0, true);
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.routine_product_enrichment_deferred, true);
        assert.equal(
          suggestedChipIds.includes('chip.aurora.next_action.routine_deep_dive'),
          false,
          'routine_products_preview should not expose routine_deep_dive without routine_fit context',
        );
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: legacy routine string also emits routine_products_preview', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_preview_legacy');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: 'AM\nCleanser: CeraVe Foaming Cleanser\nMoisturizer: CeraVe PM\nPM\nTreatment: Retinol serum',
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const preview = findCard(cards, 'routine_products_preview');
        assert.ok(preview, 'legacy string routine should still produce routine_products_preview');
        assert.equal(preview.payload && preview.payload.payload_shape, 'legacy_string');
        assert.equal(preview.payload && preview.payload.counts && preview.payload.counts.total >= 2, true);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: legacy current_routine alias also emits routine_products_preview', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_preview_legacy_alias');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            current_routine: 'AM\nCleanser: CeraVe Foaming Cleanser\nMoisturizer: CeraVe PM\nPM\nTreatment: Retinol serum',
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const preview = findCard(cards, 'routine_products_preview');
        assert.ok(preview, 'legacy current_routine should still produce routine_products_preview');
        assert.equal(preview.payload && preview.payload.payload_shape, 'legacy_string');
        assert.equal(preview.payload && preview.payload.counts && preview.payload.counts.total >= 2, true);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: nested legacy profile.currentRoutine also emits routine_products_preview', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_preview_legacy_nested_profile');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            profile: {
              currentRoutine: 'AM\nCleanser: CeraVe Foaming Cleanser\nMoisturizer: CeraVe PM\nPM\nTreatment: Retinol serum',
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const preview = findCard(cards, 'routine_products_preview');
        assert.ok(preview, 'nested legacy profile.currentRoutine should produce routine_products_preview');
        assert.equal(preview.payload && preview.payload.payload_shape, 'legacy_string');
        assert.equal(preview.payload && preview.payload.counts && preview.payload.counts.total >= 2, true);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: nested legacy profile.current_routine also emits routine_products_preview', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat(async () => ({ answer: '{}', intent: 'chat', cards: [] }));
      try {
        const uid = buildTestUid('routine_preview_legacy_nested_profile_alias');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            profile: {
              current_routine: 'AM\nCleanser: CeraVe Foaming Cleanser\nMoisturizer: CeraVe PM\nPM\nTreatment: Retinol serum',
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const preview = findCard(cards, 'routine_products_preview');
        assert.ok(preview, 'nested legacy profile.current_routine should produce routine_products_preview');
        assert.equal(preview.payload && preview.payload.payload_shape, 'legacy_string');
        assert.equal(preview.payload && preview.payload.counts && preview.payload.counts.total >= 2, true);
      } finally {
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: summary-first still allows routine audit fast path when audit env is enabled', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_SKIN_GEMINI_API_KEY: 'test-key',
      GEMINI_API_KEY: 'test-key',
      GOOGLE_API_KEY: 'test-key',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_ROUTINE_AUDIT_V1_ENABLED: 'true',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'true',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat();
      try {
        harness.routesMod.__internal.__setSkinLlmStrategyRunnersForTest({
          report: async () => buildReportSuccessStub({ lang: 'en-US' }),
          deepening: async () => ({
            ok: false,
            provider: 'gemini',
            reason: 'OPTIONAL_STEP_FAILED',
            layer: null,
          }),
        });
        const uid = buildTestUid('routine_summary_first_guard');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              schema_version: 'aurora.routine_intake.v1',
              am: [
                { step: 'cleanser', product: 'CeraVe Foaming Cleanser' },
                { step: 'sunscreen', product: 'La Roche-Posay Anthelios' },
              ],
              pm: [
                { step: 'treatment', product: 'Retinoid serum' },
                { step: 'moisturizer', product: 'CeraVe PM Lotion' },
              ],
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        assert.deepEqual(
          cards.map((card) => card.type),
          ['routine_verdict_v1', 'routine_product_audit_v1', 'routine_user_fit_v1', 'routine_adjustment_plan_v1'],
        );
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.analysis_mode, 'routine_audit_v1');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.execution_path, 'routine_audit_fast_path');
        assert.equal(
          resp.body &&
            resp.body.session_patch &&
            resp.body.session_patch.meta &&
            resp.body.session_patch.meta.analysis_contract &&
            resp.body.session_patch.meta.analysis_contract.card_contract,
          'aurora.routine_audit_v1',
        );
      } finally {
        harness.routesMod.__internal.__resetSkinLlmStrategyRunnersForTest();
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: report-stage timeout degrades quickly and preserves routine preview', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_SKIN_GEMINI_API_KEY: 'test-key',
      GEMINI_API_KEY: 'test-key',
      GOOGLE_API_KEY: 'test-key',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_BFF_ANALYSIS_BUDGET_MS: '5000',
      AURORA_ANALYSIS_REPORT_STAGE_BUDGET_MS: '350',
      AURORA_ANALYSIS_REPORT_STAGE_MIN_REMAINING_MS: '250',
      AURORA_ANALYSIS_REPORT_STAGE_RESERVE_MS: '0',
      AURORA_ANALYSIS_REPORT_STAGE_TIMEOUT_FLOOR_MS: '100',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat();
      try {
        harness.routesMod.__internal.__setSkinLlmStrategyRunnersForTest({
          report: async () => {
            await sleep(4000);
            return buildReportSuccessStub({ lang: 'en-US' });
          },
        });
        const uid = buildTestUid('routine_report_stage_timeout');
        const startedAt = Date.now();
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              schema_version: 'aurora.routine_intake.v1',
              am: [
                { step: 'cleanser', product: 'CeraVe Foaming Cleanser' },
                { step: 'sunscreen', product: 'La Roche-Posay Anthelios' },
              ],
              pm: [
                { step: 'treatment', product: 'Retinoid serum' },
                { step: 'moisturizer', product: 'CeraVe PM Lotion' },
              ],
            },
          })
          .expect(200);
        const elapsedMs = Date.now() - startedAt;

        const cards = parseCards(resp.body);
        const analysisSummary = findCard(cards, 'analysis_summary') || findCard(cards, 'analysis_story_v2');
        const preview = findCard(cards, 'routine_products_preview');

        assert.ok(analysisSummary, 'analysis card should still exist');
        assert.ok(preview, 'routine preview should still exist');
        assert.equal(elapsedMs < 3000, true, `request should degrade quickly, got ${elapsedMs}ms`);
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_outcome, 'budget_timeout');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_failure_reason, 'REPORT_STAGE_BUDGET_TIMEOUT');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.budget_abort_stage, 'report');
        assert.equal(Number(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_attempts), 1);
      } finally {
        harness.routesMod.__internal.__resetSkinLlmStrategyRunnersForTest();
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: successful report stage exposes stage timing metadata', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_SKIN_GEMINI_API_KEY: 'test-key',
      GEMINI_API_KEY: 'test-key',
      GOOGLE_API_KEY: 'test-key',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_BFF_ANALYSIS_BUDGET_MS: '5000',
      AURORA_ANALYSIS_REPORT_STAGE_BUDGET_MS: '2000',
      AURORA_ANALYSIS_REPORT_STAGE_MIN_REMAINING_MS: '250',
      AURORA_ANALYSIS_REPORT_STAGE_RESERVE_MS: '0',
      AURORA_ANALYSIS_REPORT_STAGE_TIMEOUT_FLOOR_MS: '100',
    },
    async () => {
      const harness = createAppWithPatchedAuroraChat();
      try {
        harness.routesMod.__internal.__setSkinLlmStrategyRunnersForTest({
          report: async () => buildReportSuccessStub({ lang: 'en-US' }),
          deepening: async () => ({
            ok: false,
            provider: 'gemini',
            reason: 'OPTIONAL_STEP_FAILED',
            layer: null,
          }),
        });
        const uid = buildTestUid('routine_report_stage_success');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              schema_version: 'aurora.routine_intake.v1',
              am: [
                { step: 'cleanser', product: 'CeraVe Foaming Cleanser' },
                { step: 'sunscreen', product: 'La Roche-Posay Anthelios' },
              ],
              pm: [
                { step: 'treatment', product: 'Retinoid serum' },
                { step: 'moisturizer', product: 'CeraVe PM Lotion' },
              ],
            },
            recentLogs: [{ reaction: 'stinging after serum' }],
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const analysisSummary = findCard(cards, 'analysis_summary') || findCard(cards, 'analysis_story_v2');
        assert.ok(analysisSummary, 'analysis card should exist');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_outcome, 'success');
        assert.equal(Number(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_budget_ms) > 0, true);
        assert.equal(Number(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_elapsed_ms) >= 0, true);
        assert.equal(Number(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_attempts) >= 1, true);
        assert.equal(
          Number(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.stage_timings_ms && resp.body.analysis_meta.stage_timings_ms.report) >= 0,
          true,
        );
        assert.ok(typeof (resp.body && resp.body.analysis_meta && resp.body.analysis_meta.slowest_stage) === 'string');
      } finally {
        harness.routesMod.__internal.__resetSkinLlmStrategyRunnersForTest();
        harness.restore();
      }
    },
  );
});

test('/v1/analysis/skin: deterministic report fallback recovers summary without deepening retry fanout', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_SKIN_GEMINI_API_KEY: 'test-key',
      GEMINI_API_KEY: 'test-key',
      GOOGLE_API_KEY: 'test-key',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'true',
      AURORA_BFF_ANALYSIS_BUDGET_MS: '5000',
      AURORA_ANALYSIS_REPORT_STAGE_BUDGET_MS: '2000',
      AURORA_ANALYSIS_REPORT_STAGE_MIN_REMAINING_MS: '250',
      AURORA_ANALYSIS_REPORT_STAGE_RESERVE_MS: '0',
      AURORA_ANALYSIS_REPORT_STAGE_TIMEOUT_FLOOR_MS: '100',
      AURORA_ANALYSIS_QUALITY_SLOW_MS: '1',
      AURORA_ANALYSIS_ARTIFACT_SLOW_MS: '1',
    },
    async () => {
      resetVisionMetrics();
      const harness = createAppWithPatchedAuroraChat();
      let deepeningCalls = 0;
      try {
        harness.routesMod.__internal.__setSkinLlmStrategyRunnersForTest({
          report: async () => ({
            ...buildReportSuccessStub({ lang: 'en-US' }),
            provider: 'deterministic_local',
            retry: { attempted: 1, final: 'success', last_reason: 'deterministic_fallback' },
            semantic: { ok: true, useful_output: false, issues: ['UPSTREAM_5XX'] },
            fallback_reason: 'UPSTREAM_5XX',
            __deterministic_fallback: true,
          }),
          deepening: async () => {
            deepeningCalls += 1;
            return {
              ok: true,
              provider: 'gemini',
              reason: null,
              layer: { summary: 'should not run' },
            };
          },
        });
        const uid = buildTestUid('routine_report_stage_recovered');
        const resp = await harness.request
          .post('/v1/analysis/skin')
          .set(headersFor(uid, 'EN'))
          .send({
            use_photo: false,
            currentRoutine: {
              schema_version: 'aurora.routine_intake.v1',
              am: [
                { step: 'cleanser', product: 'CeraVe Foaming Cleanser' },
                { step: 'sunscreen', product: 'La Roche-Posay Anthelios' },
              ],
              pm: [
                { step: 'treatment', product: 'Retinoid serum' },
                { step: 'moisturizer', product: 'CeraVe PM Lotion' },
              ],
            },
          })
          .expect(200);

        const cards = parseCards(resp.body);
        const analysisSummary = findCard(cards, 'analysis_summary') || findCard(cards, 'analysis_story_v2');
        const preview = findCard(cards, 'routine_products_preview');

        assert.ok(analysisSummary, 'analysis card should still exist');
        assert.ok(preview, 'routine preview should still exist');
        assert.equal(deepeningCalls, 0, 'deepening should not run after recovered report fallback');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_outcome, 'deterministic_fallback');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_recovered, true);
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_recovery_mode, 'deterministic_fallback');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_stage_primary_failure_reason, 'UPSTREAM_5XX');
        assert.equal(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.report_failure_reason == null, true);
        assert.notEqual(resp.body && resp.body.analysis_meta && resp.body.analysis_meta.degrade_reason, 'report_model_error');

        const snap = snapshotVisionMetrics();
        assert.ok(
          getLabeledCounterValue(snap.auroraSkinFlow, { stage: 'analysis_report_recovered', outcome: 'hit' }) >= 1,
          'expected generic report recovery metric',
        );
        assert.ok(
          getLabeledCounterValue(snap.auroraSkinFlow, { stage: 'analysis_report_recovered_upstream_5xx', outcome: 'hit' }) >= 1,
          'expected recovered report failure reason metric',
        );
        assert.ok(
          getLabeledCounterValue(snap.auroraSkinFlow, { stage: 'analysis_quality_slow', outcome: 'hit' }) >= 1,
          'expected quality slow-stage metric',
        );
      } finally {
        harness.routesMod.__internal.__resetSkinLlmStrategyRunnersForTest();
        harness.restore();
      }
    },
  );
});

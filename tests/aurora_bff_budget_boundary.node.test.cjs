const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sleep,
  withEnv,
  buildTestUid,
  headersFor,
  createAppWithPatchedAuroraChat,
  seedCompleteProfile,
  parseCards,
  findCard,
  patchPhotoDownloadAxios,
  createDiagnosisArtifactFixture,
  seedDiagnosisArtifactForUid,
} = require('./aurora_bff_test_harness.cjs');

function timeoutReason(cards) {
  const notice = findCard(cards, 'confidence_notice');
  return notice && notice.payload ? String(notice.payload.reason || '') : '';
}

async function runAnalysisBudgetCase({ budgetMs, delayMs, expectTimeout }) {
  const env = {
    AURORA_BFF_USE_MOCK: 'false',
    AURORA_BFF_RETENTION_DAYS: '0',
    AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
    AURORA_SKIN_VISION_ENABLED: 'true',
    AURORA_SKIN_FORCE_VISION_CALL: 'true',
    PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
    PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
    ...(budgetMs == null ? { AURORA_BFF_ANALYSIS_BUDGET_MS: undefined } : { AURORA_BFF_ANALYSIS_BUDGET_MS: String(budgetMs) }),
  };

  await withEnv(env, async () => {
    const restoreAxios = patchPhotoDownloadAxios({ mode: 'ok' });
    const harness = createAppWithPatchedAuroraChat(async () => ({ answer: 'ok', intent: 'chat', cards: [] }));
    try {
      harness.routesMod.__internal.__setVisionRunnersForTest({
        gemini: async () => {
          await sleep(delayMs);
          return {
            ok: true,
            provider: 'gemini',
            analysis: {
              summary: 'budget boundary analysis',
              confidence: 0.72,
              findings: [],
            },
          };
        },
        openai: async () => ({
          ok: true,
          provider: 'openai',
          analysis: { summary: 'unused', confidence: 0.7, findings: [] },
        }),
      });

      const uid = buildTestUid(`budget_analysis_${budgetMs == null ? 'default' : budgetMs}_${delayMs}`);
      const resp = await harness.request
        .post('/v1/analysis/skin')
        .set(headersFor(uid, 'EN'))
        .send({
          use_photo: true,
          currentRoutine: 'AM cleanser + SPF; PM moisturizer',
          photos: [{ slot_id: 'daylight', photo_id: `photo_budget_${Date.now()}`, qc_status: 'passed' }],
        })
        .expect(200);

      const cards = parseCards(resp.body);
      assert.ok(findCard(cards, 'analysis_summary'));
      const reason = timeoutReason(cards);
      if (expectTimeout) {
        assert.equal(reason, 'timeout_degraded');
      } else {
        assert.notEqual(reason, 'timeout_degraded');
      }
    } finally {
      harness.routesMod.__internal.__resetVisionRunnersForTest();
      restoreAxios();
      harness.restore();
    }
  });
}

async function runRecoBudgetCase({ budgetMs, delayMs, expectTimeout }) {
  const env = {
    AURORA_BFF_USE_MOCK: 'false',
    AURORA_BFF_RETENTION_DAYS: '0',
    AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
    AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    ...(budgetMs == null ? { AURORA_BFF_CHAT_RECO_BUDGET_MS: undefined } : { AURORA_BFF_CHAT_RECO_BUDGET_MS: String(budgetMs) }),
  };

  await withEnv(env, async () => {
    const harness = createAppWithPatchedAuroraChat(async () => {
      await sleep(delayMs);
      return {
        answer: '{}',
        intent: 'chat',
        recommendations: [
          {
            step: 'Moisturizer',
            slot: 'pm',
            category: 'moisturizer',
            sku: { sku_id: 'sku_budget_1', name: 'Budget Boundary Cream' },
          },
        ],
      };
    });

    try {
      const uid = buildTestUid(`budget_reco_${budgetMs == null ? 'default' : budgetMs}_${delayMs}`);
      await seedCompleteProfile(harness.request, uid, 'EN');
      await seedDiagnosisArtifactForUid(
        uid,
        createDiagnosisArtifactFixture({
          confidenceScore: 0.86,
          confidenceLevel: 'high',
          analysisSource: 'rule_based',
          usePhoto: true,
          qualityGrade: 'pass',
        }),
      );

      const resp = await harness.request
        .post('/v1/chat')
        .set(headersFor(uid, 'EN'))
        .send({
          message: 'recommend products',
          action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
          language: 'EN',
          session: { state: 'idle' },
        })
        .expect(200);

      const cards = parseCards(resp.body);
      const reason = timeoutReason(cards);
      if (expectTimeout) {
        assert.equal(reason, 'timeout_degraded');
      } else {
        assert.notEqual(reason, 'timeout_degraded');
        assert.ok(findCard(cards, 'recommendations'));
      }
    } finally {
      harness.restore();
    }
  });
}

test('P1-1 analysis budget boundaries: tight degrades, relaxed/default pass', async () => {
  await runAnalysisBudgetCase({ budgetMs: 1000, delayMs: 1400, expectTimeout: true });
  await runAnalysisBudgetCase({ budgetMs: 5000, delayMs: 150, expectTimeout: false });
  await runAnalysisBudgetCase({ budgetMs: null, delayMs: 50, expectTimeout: false });
});

test('P1-1 reco budget boundaries: tight degrades, relaxed/default pass', async () => {
  await runRecoBudgetCase({ budgetMs: 1000, delayMs: 1400, expectTimeout: true });
  await runRecoBudgetCase({ budgetMs: 5000, delayMs: 150, expectTimeout: false });
  await runRecoBudgetCase({ budgetMs: null, delayMs: 50, expectTimeout: false });
});

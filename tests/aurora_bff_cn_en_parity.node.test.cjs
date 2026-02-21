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
  createDiagnosisArtifactFixture,
  seedDiagnosisArtifactForUid,
} = require('./aurora_bff_test_harness.cjs');

function normalizeActions(payload) {
  const actions = Array.isArray(payload && payload.actions) ? payload.actions : [];
  return Array.from(new Set(actions.map((x) => String(x || '').trim()).filter(Boolean))).sort();
}

function looksTreatmentOrHighIrritation(rec) {
  const row = rec && typeof rec === 'object' ? rec : {};
  const bucket = [
    row.step,
    row.slot,
    row.category,
    row.name,
    row.title,
    row.sku && row.sku.name,
    ...(Array.isArray(row.notes) ? row.notes : []),
    ...(Array.isArray(row.reasons) ? row.reasons : []),
  ]
    .filter((x) => x != null)
    .map((x) => String(x).toLowerCase())
    .join(' | ');
  return /\b(treatment|retinoid|retinol|retinal|tretinoin|adapalene|aha|bha|salicylic|glycolic|lactic|mandelic|peel|resurfacing)\b/.test(bucket);
}

function summarizeResponseCards(cards) {
  const notice = findCard(cards, 'confidence_notice');
  const reco = findCard(cards, 'recommendations');
  const recommendations = Array.isArray(reco && reco.payload && reco.payload.recommendations)
    ? reco.payload.recommendations
    : [];
  const treatmentLeakCount = recommendations.filter((row) => looksTreatmentOrHighIrritation(row)).length;
  const reason = notice && notice.payload ? String(notice.payload.reason || '') : '';
  return {
    reason,
    actions: normalizeActions(notice && notice.payload),
    hasNotice: Boolean(notice),
    hasRecommendations: recommendations.length > 0,
    recommendationsCount: recommendations.length,
    treatmentLeakCount,
    cardTypes: cards.map((c) => String(c && c.type || '')).filter(Boolean).sort(),
  };
}

function makeUpstreamBehavior(kind) {
  if (kind === 'empty_cards') {
    return async () => ({ answer: '{}', intent: 'chat', cards: [] });
  }
  if (kind === 'invalid_shape') {
    return async () => ({ answer: '<html>oops</html>', intent: 'chat', foo: 'bar' });
  }
  if (kind === 'delay') {
    return async () => {
      await sleep(1400);
      return {
        answer: '{}',
        intent: 'chat',
        recommendations: [{ step: 'Moisturizer', slot: 'pm', sku: { sku_id: 'sku_delay', name: 'Delay Cream' } }],
      };
    };
  }
  if (kind === 'conn_reset') {
    return async () => {
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    };
  }
  if (kind === 'treatment_only') {
    return async () => ({
      answer: '{}',
      intent: 'chat',
      structured: {
        recommendations: [
          {
            step: 'Treatment',
            slot: 'pm',
            category: 'treatment',
            notes: ['retinoid', 'glycolic acid'],
            sku: { sku_id: 'sku_treat_only', name: 'Strong Treatment' },
          },
        ],
      },
    });
  }
  if (kind === 'mixed_reco') {
    return async () => ({
      answer: '{}',
      intent: 'chat',
      structured: {
        recommendations: [
          {
            step: 'Treatment',
            slot: 'pm',
            category: 'treatment',
            notes: ['retinoid'],
            sku: { sku_id: 'sku_treat_mixed', name: 'Retinoid Night' },
          },
          {
            step: 'Moisturizer',
            slot: 'pm',
            category: 'moisturizer',
            notes: ['ceramides'],
            sku: { sku_id: 'sku_moist_mixed', name: 'Barrier Cream' },
          },
        ],
      },
    });
  }
  return async () => ({
    answer: '{}',
    intent: 'chat',
    recommendations: [{ step: 'Moisturizer', slot: 'pm', sku: { sku_id: 'sku_ok_1', name: 'Calm Cream' } }],
  });
}

async function runScenarioForLang(scenario, lang) {
  const env = {
    AURORA_BFF_USE_MOCK: scenario.useMock ? 'true' : 'false',
    AURORA_BFF_RETENTION_DAYS: '0',
    AURORA_DIAG_ARTIFACT_RETENTION_DAYS: '0',
    AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
    AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    ...(scenario.recoBudgetMs ? { AURORA_BFF_CHAT_RECO_BUDGET_MS: String(scenario.recoBudgetMs) } : {}),
  };

  return withEnv(env, async () => {
    const harness = createAppWithPatchedAuroraChat(
      scenario.useMock ? null : makeUpstreamBehavior(scenario.upstreamKind),
    );
    const uid = buildTestUid(`parity_${scenario.id}_${lang}`);
    try {
      await seedCompleteProfile(harness.request, uid, lang);
      if (scenario.artifact === 'high' || scenario.artifact === 'medium' || scenario.artifact === 'low') {
        const defaultsByLevel = {
          high: { confidenceScore: 0.86, confidenceLevel: 'high' },
          medium: { confidenceScore: 0.66, confidenceLevel: 'medium' },
          low: {
            confidenceScore: 0.42,
            confidenceLevel: 'low',
            analysisSource: 'baseline_low_confidence',
            usePhoto: false,
            qualityGrade: 'degraded',
          },
        };
        await seedDiagnosisArtifactForUid(
          uid,
          createDiagnosisArtifactFixture({
            ...(defaultsByLevel[scenario.artifact] || {}),
            ...(scenario.artifactFixture || {}),
          }),
        );
      }

      const localizedMessage =
        typeof scenario.messageByLang === 'function'
          ? scenario.messageByLang(lang)
          : lang === 'CN'
            ? '请推荐适合我的护肤品'
            : 'Please recommend skincare products for me';

      const resp = await harness.request
        .post('/v1/chat')
        .set(headersFor(uid, lang))
        .send({
          message: localizedMessage,
          action: { action_id: 'chip.start.reco_products', kind: 'chip', data: {} },
          language: lang,
          session: { state: 'idle' },
        })
        .expect(200);

      const cards = parseCards(resp.body);
      const summary = summarizeResponseCards(cards);

      if (scenario.expectedReason) {
        assert.equal(summary.reason, scenario.expectedReason, `scenario=${scenario.id} lang=${lang}`);
      }
      if (scenario.expectRecommendations === true) {
        assert.equal(summary.hasRecommendations, true, `scenario=${scenario.id} lang=${lang} should have recommendations`);
      }
      if (scenario.expectRecommendations === false) {
        assert.equal(summary.hasRecommendations, false, `scenario=${scenario.id} lang=${lang} should not have recommendations`);
      }
      if (scenario.expectNoTreatmentLeak === true) {
        assert.equal(summary.treatmentLeakCount, 0, `scenario=${scenario.id} lang=${lang} should not leak treatment/high-irritation`);
      }
      return summary;
    } finally {
      harness.restore();
    }
  });
}

test('P2-2 CN/EN parity: structure and reason remain aligned across 20 scenario runs', async () => {
  const scenarios = [
    {
      id: 'artifact_missing_empty_cards',
      artifact: 'none',
      upstreamKind: 'empty_cards',
      expectedReason: 'artifact_missing',
      expectRecommendations: false,
    },
    {
      id: 'artifact_missing_invalid_shape',
      artifact: 'none',
      upstreamKind: 'invalid_shape',
      expectedReason: 'artifact_missing',
      expectRecommendations: false,
    },
    {
      id: 'timeout_delay',
      artifact: 'high',
      upstreamKind: 'delay',
      recoBudgetMs: 1000,
      expectedReason: 'timeout_degraded',
      expectRecommendations: false,
    },
    {
      id: 'timeout_conn_reset',
      artifact: 'high',
      upstreamKind: 'conn_reset',
      expectedReason: 'timeout_degraded',
      expectRecommendations: false,
    },
    {
      id: 'low_conf_treatment_only',
      artifact: 'low',
      upstreamKind: 'treatment_only',
      expectedReason: 'low_confidence',
      expectRecommendations: false,
    },
    {
      id: 'low_conf_mixed_reco',
      artifact: 'low',
      upstreamKind: 'mixed_reco',
      expectedReason: 'low_confidence',
      expectRecommendations: true,
    },
    {
      id: 'safety_block_en_signal',
      artifact: 'high',
      upstreamKind: 'normal',
      expectedReason: 'safety_block',
      expectRecommendations: false,
      messageByLang: (lang) =>
        lang === 'CN'
          ? '我现在有 severe pain, bleeding 和 pus'
          : 'I have severe pain with bleeding and pus now',
    },
    {
      id: 'safety_block_cn_signal',
      artifact: 'high',
      upstreamKind: 'normal',
      expectedReason: 'safety_block',
      expectRecommendations: false,
      messageByLang: () => '我脸上剧痛并且有出血和化脓',
    },
    {
      id: 'recommendations_high',
      artifact: 'high',
      upstreamKind: 'normal',
      useMock: true,
      expectRecommendations: true,
    },
    {
      id: 'recommendations_medium',
      artifact: 'medium',
      upstreamKind: 'normal',
      useMock: true,
      expectRecommendations: false,
    },
    {
      id: 'medium_rule_based_use_photo_false_no_treatment_leak',
      artifact: 'medium',
      artifactFixture: {
        confidenceScore: 0.66,
        confidenceLevel: 'medium',
        analysisSource: 'rule_based',
        usePhoto: false,
        qualityGrade: 'degraded',
      },
      upstreamKind: 'mixed_reco',
      expectRecommendations: true,
      expectNoTreatmentLeak: true,
    },
  ];

  let runCount = 0;
  for (const scenario of scenarios) {
    const en = await runScenarioForLang(scenario, 'EN');
    const cn = await runScenarioForLang(scenario, 'CN');
    runCount += 2;

    assert.equal(cn.reason, en.reason, `reason parity failed: ${scenario.id}`);
    assert.deepEqual(cn.actions, en.actions, `actions parity failed: ${scenario.id}`);
    assert.equal(cn.hasRecommendations, en.hasRecommendations, `recommendation parity failed: ${scenario.id}`);
    assert.equal(cn.hasNotice, en.hasNotice, `notice parity failed: ${scenario.id}`);
  }

  assert.equal(runCount, scenarios.length * 2);
});

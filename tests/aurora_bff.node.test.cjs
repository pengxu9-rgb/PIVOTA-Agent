const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const {
  shouldDiagnosisGate,
  buildDiagnosisChips,
  recommendationsAllowed,
  stateChangeAllowed,
  stripRecommendationCards,
} = require('../src/auroraBff/gating');
const { normalizeRecoGenerate } = require('../src/auroraBff/normalize');
const { simulateConflicts } = require('../src/auroraBff/routineRules');
const { buildConflictHeatmapV1 } = require('../src/auroraBff/conflictHeatmapV1');
const { auroraChat } = require('../src/auroraBff/auroraDecisionClient');
const { resetVisionMetrics, snapshotVisionMetrics } = require('../src/auroraBff/visionMetrics');
const { createStageProfiler } = require('../src/auroraBff/skinAnalysisProfiling');
const { should_call_llm: shouldCallLlm } = require('../src/auroraBff/skinLlmPolicy');
const { getDiagRolloutDecision, hashToBucket0to99 } = require('../src/auroraBff/diagRollout');
const { validateRequestedTransition } = require('../src/auroraBff/agentStateMachine');

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

function getLabeledCounterValue(entries, expectedLabels) {
  const list = Array.isArray(entries) ? entries : [];
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [key, value] = item;
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

function getUpstreamCallTotal(entries, { path, status } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  let total = 0;
  for (const item of list) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [key, value] = item;
    let labels = null;
    try {
      labels = JSON.parse(key);
    } catch (_err) {
      labels = null;
    }
    if (!labels || typeof labels !== 'object') continue;
    if (path != null && String(labels.path) !== String(path)) continue;
    if (status != null && String(labels.status) !== String(status)) continue;
    total += Number(value) || 0;
  }
  return total;
}

test('normalizeClarificationField: maps common skinType ids (ASCII/CN) to canonical field', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(__internal.normalizeClarificationField('skin_type'), 'skinType');
    assert.equal(__internal.normalizeClarificationField('皮肤类型'), 'skinType');
    assert.equal(__internal.normalizeClarificationField('肤质:油皮'), 'skinType');
  } finally {
    delete require.cache[moduleId];
  }
});

test('normalizeClarificationField: never returns empty; falls back to stable hash + emits metric', () => {
  resetVisionMetrics();

  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out1 = __internal.normalizeClarificationField('!!!');
    const out2 = __internal.normalizeClarificationField('');
    const out3 = __internal.normalizeClarificationField(null);

    for (const out of [out1, out2, out3]) {
      assert.equal(typeof out, 'string');
      assert.ok(out.length > 0);
      assert.match(out, /^cid_[a-z0-9]+$/);
    }
  } finally {
    delete require.cache[moduleId];
  }

  const snap = snapshotVisionMetrics();
  assert.ok(Number(snap.clarificationIdNormalizedEmptyCount) >= 3);
});

test('ensureNonEmptyChatCardsEnvelope: reco-stage empty cards degrade to timeout confidence notice when timeout events present', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const recoEnvelope = {
      assistant_message: null,
      suggested_chips: [],
      cards: [],
      session_patch: {},
      events: [
        { event_name: 'recos_requested', data: { explicit: true } },
        { event_name: 'recos_requested', data: { explicit: true, reason: 'timeout_degraded' } },
      ],
    };
    assert.equal(__internal.shouldApplyRecoOutputGuard({ envelope: recoEnvelope, ctx: { state: 'S7_PRODUCT_RECO' } }), true);

    const guarded = __internal.ensureNonEmptyChatCardsEnvelope({
      envelope: recoEnvelope,
      ctx: { request_id: 'req_guard_timeout', trace_id: 'trace_guard_timeout' },
      language: 'CN',
    });
    assert.equal(guarded.applied, true);
    assert.equal(guarded.reason, 'timeout_degraded');
    const cards = Array.isArray(guarded.envelope.cards) ? guarded.envelope.cards : [];
    assert.equal(cards.length, 1);
    assert.equal(cards[0].type, 'confidence_notice');
    assert.equal(cards[0]?.payload?.reason, 'timeout_degraded');
    assert.ok(Array.isArray(cards[0]?.payload?.actions) && cards[0].payload.actions.length > 0);
  } finally {
    delete require.cache[moduleId];
  }
});

test('ensureNonEmptyChatCardsEnvelope: reco-stage empty cards fallback to artifact_missing without timeout signal', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const recoEnvelope = {
      assistant_message: null,
      suggested_chips: [],
      cards: [],
      session_patch: {},
      events: [{ event_name: 'recos_requested', data: { explicit: true } }],
    };
    const guarded = __internal.ensureNonEmptyChatCardsEnvelope({
      envelope: recoEnvelope,
      ctx: { request_id: 'req_guard_artifact', trace_id: 'trace_guard_artifact' },
      language: 'EN',
    });
    assert.equal(guarded.applied, true);
    assert.equal(guarded.reason, 'artifact_missing');
    assert.equal(guarded.envelope?.cards?.[0]?.type, 'confidence_notice');
    assert.equal(guarded.envelope?.cards?.[0]?.payload?.reason, 'artifact_missing');
  } finally {
    delete require.cache[moduleId];
  }
});

test('shouldApplyRecoOutputGuard: non-reco empty envelope should not trigger guard', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const nonRecoEnvelope = {
      assistant_message: { role: 'assistant', content: 'hi', format: 'markdown' },
      suggested_chips: [],
      cards: [],
      session_patch: {},
      events: [{ event_name: 'value_moment', data: { kind: 'chat_reply' } }],
    };
    assert.equal(__internal.shouldApplyRecoOutputGuard({ envelope: nonRecoEnvelope, ctx: { state: 'idle' } }), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('detectBrandAvailabilityIntent: detects Winona/IPSA availability intent (CN/EN/mixed) and rejects generic diagnosis', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const cn = __internal.detectBrandAvailabilityIntent('有没有薇诺娜的产品', 'CN');
    assert.ok(cn);
    assert.equal(cn.intent, 'availability');
    assert.equal(cn.brand_id, 'brand_winona');

    const en = __internal.detectBrandAvailabilityIntent('Winona 有货吗？', 'CN');
    assert.ok(en);
    assert.equal(en.intent, 'availability');
    assert.equal(en.brand_id, 'brand_winona');

    const mixed = __internal.detectBrandAvailabilityIntent('请问薇诺娜/Winona', 'CN');
    assert.ok(mixed);
    assert.equal(mixed.intent, 'availability');
    assert.equal(mixed.brand_id, 'brand_winona');

    const ipsaCn = __internal.detectBrandAvailabilityIntent('茵芙莎有货吗', 'CN');
    assert.ok(ipsaCn);
    assert.equal(ipsaCn.intent, 'availability');
    assert.equal(ipsaCn.brand_id, 'brand_ipsa');

    const ipsaEn = __internal.detectBrandAvailabilityIntent('IPSA available?', 'EN');
    assert.ok(ipsaEn);
    assert.equal(ipsaEn.intent, 'availability');
    assert.equal(ipsaEn.brand_id, 'brand_ipsa');

    assert.equal(__internal.detectBrandAvailabilityIntent('我脸很红怎么办', 'CN'), null);
    assert.equal(__internal.detectBrandAvailabilityIntent('我皮肤很干怎么办', 'CN'), null);
  } finally {
    delete require.cache[moduleId];
  }
});

test('detectCatalogAvailabilityIntent: detects generic non-whitelist availability target', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const genericEn = __internal.detectCatalogAvailabilityIntent(
      'Do you have The Ordinary Niacinamide 10% + Zinc 1%?',
      'EN',
    );
    assert.ok(genericEn);
    assert.equal(genericEn.intent, 'availability');
    assert.equal(genericEn.brand_id, 'brand_generic');
    assert.match(String(genericEn.brand_name || '').toLowerCase(), /ordinary|niacinamide/);

    const genericCn = __internal.detectCatalogAvailabilityIntent('有The Ordinary烟酰胺10%+锌1%吗？', 'CN');
    assert.ok(genericCn);
    assert.equal(genericCn.intent, 'availability');
    assert.equal(genericCn.brand_id, 'brand_generic');

    assert.equal(__internal.detectCatalogAvailabilityIntent('Do you have products?', 'EN'), null);
  } finally {
    delete require.cache[moduleId];
  }
});

test('isSpecificAvailabilityQuery: brand-only availability question is not treated as specific SKU lookup', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const intentCn = { brand_name: '薇诺娜', matched_alias: '薇诺娜', brand_id: 'brand_winona' };
    const intentEn = { brand_name: 'Winona', matched_alias: 'winona', brand_id: 'brand_winona' };
    const genericIntent = {
      brand_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
      matched_alias: '',
      brand_id: 'brand_generic',
    };

    assert.equal(__internal.isSpecificAvailabilityQuery('有没有薇诺娜的产品', intentCn), false);
    assert.equal(__internal.isSpecificAvailabilityQuery('Winona products in stock?', intentEn), false);
    assert.equal(__internal.isSpecificAvailabilityQuery('Winona Soothing Repair Serum 有货吗', intentEn), true);
    assert.equal(
      __internal.isSpecificAvailabilityQuery('Do you have The Ordinary Niacinamide 10% + Zinc 1%?', genericIntent),
      true,
    );
    assert.equal(__internal.isSpecificAvailabilityQuery('Do you have products?', { brand_id: 'brand_generic' }), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('/v1/chat: brand availability query short-circuits to commerce cards (no auroraChat, no diagnosis intake)', async () => {
  resetVisionMetrics();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await supertest(app)
    .post('/v1/chat')
    .set({ 'X-Aurora-UID': 'test_uid_brand_availability', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' })
    .send({
      message: '有没有薇诺娜的产品',
      session: { state: 'idle', profile: { skinType: 'oily' } },
      language: 'CN',
    })
    .expect(200);

  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const types = cards.map((c) => (c && typeof c.type === 'string' ? c.type : '')).filter(Boolean);
  assert.ok(types.includes('product_parse'));
  assert.ok(types.includes('offers_resolved'));
  assert.equal(types.includes('diagnosis_gate'), false);

  const assistant = String(resp.body?.assistant_message?.content || '');
  assert.equal(/油皮|干皮|混合|皮肤类型|肤质|skin type|barrier|屏障|目标|goal/i.test(assistant), false);

  const events = Array.isArray(resp.body?.events) ? resp.body.events : [];
  assert.ok(events.some((e) => e && e.event_name === 'catalog_availability_shortcircuit'));

  const snap = snapshotVisionMetrics();
  const auroraChatCalls = (Array.isArray(snap.upstreamCalls) ? snap.upstreamCalls : []).filter(([key]) => {
    try {
      return JSON.parse(key).path === 'aurora_chat';
    } catch (_err) {
      return false;
    }
  });
  assert.equal(auroraChatCalls.length, 0);
});

test('Emotional preamble: strips mismatched CN greeting when language is EN', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal: auroraRouteInternals } = require('../src/auroraBff/routes');
  const input = '晚上好，辛苦一天了，我们放松着来。\n\nHere is your plan.';
  const out = auroraRouteInternals.addEmotionalPreambleToAssistantText(input, {
    language: 'EN',
    profile: { region: 'US' },
    seed: 'seed-en-1',
  });
  delete require.cache[moduleId];
  const firstLine = String(out || '').split(/\r?\n/)[0] || '';
  assert.match(firstLine, /^(Good (morning|afternoon|evening)|Late-night check-in|It’s late|Quick night plan)/);
  assert.equal(/^晚上好|^下午好|^早上好|^夜深了|^夜里好/.test(firstLine), false);
});

test('Emotional preamble: has deterministic multi-variant choices for CN and EN', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal: auroraRouteInternals } = require('../src/auroraBff/routes');
  const now = new Date('2026-02-08T06:30:00.000Z');
  const cnSet = new Set();
  const enSet = new Set();
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
    cnSet.add(
      auroraRouteInternals.buildEmotionalPreamble({
        language: 'CN',
        profile: { region: 'CN' },
        now,
        seed,
      }),
    );
    enSet.add(
      auroraRouteInternals.buildEmotionalPreamble({
        language: 'EN',
        profile: { region: 'US' },
        now,
        seed,
      }),
    );
  }
  delete require.cache[moduleId];
  assert.ok(cnSet.size >= 2);
  assert.ok(enSet.size >= 2);
  for (const line of cnSet) {
    assert.equal(/焦虑|别慌/.test(String(line || '')), false);
  }
  for (const line of enSet) {
    assert.equal(/\banxious\b|\blow-stress\b/i.test(String(line || '')), false);
  }
});

test('Emotional preamble: does not double-prefix existing known preamble', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal: auroraRouteInternals } = require('../src/auroraBff/routes');

  const base = 'Got it — I’ll keep it clear and practical.';
  const input = `${base}\n\nHere is your plan.`;
  const out = auroraRouteInternals.addEmotionalPreambleToAssistantText(input, {
    language: 'EN',
    profile: { region: 'US' },
    seed: 'seed-en-no-double',
  });
  delete require.cache[moduleId];

  const occurrences = String(out || '').split(base).length - 1;
  assert.equal(occurrences, 1);
  assert.match(String(out || ''), /^Got it — I’ll keep it clear and practical\./);
});

test('mergePhotoFindingsIntoAnalysis: injects photo findings/takeaways with explicit photo source', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal: auroraRouteInternals } = require('../src/auroraBff/routes');
  const merged = auroraRouteInternals.mergePhotoFindingsIntoAnalysis({
    analysis: {
      features: [{ observation: 'safe baseline', confidence: 'somewhat_sure' }],
      strategy: 'test?',
    },
    diagnosisV1: {
      photo_findings: [
        {
          issue_type: 'redness',
          subtype: 'diffuse_redness_proxy',
          severity: 2,
          confidence: 0.74,
          evidence: 'a* shift elevated',
          computed_features: { red_fraction: 0.31 },
          geometry: { type: 'grid', rows: 2, cols: 2, values: [0.1, 0.2, 0.3, 0.4] },
        },
      ],
      takeaways: [{ source: 'photo', issue_type: 'redness', text: 'reduce irritation', confidence: 0.66 }],
    },
    language: 'EN',
    profileSummary: { goals: ['acne'] },
  });
  delete require.cache[moduleId];

  assert.ok(Array.isArray(merged.photo_findings));
  assert.equal(merged.photo_findings.length, 1);
  assert.ok(Array.isArray(merged.findings));
  assert.equal(merged.findings.length, 1);
  assert.ok(Array.isArray(merged.takeaways));
  assert.ok(merged.takeaways.some((item) => /^From photo:/i.test(String(item?.text || ''))));
  assert.ok(merged.takeaways.some((item) => item && item.source === 'user'));
});

test('buildExecutablePlanForAnalysis: used_photos=false keeps non-photo takeaways and photo_notice', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal: auroraRouteInternals } = require('../src/auroraBff/routes');
  const enriched = auroraRouteInternals.buildExecutablePlanForAnalysis({
    analysis: {
      features: [{ observation: 'baseline', confidence: 'somewhat_sure' }],
      strategy: 'placeholder?',
      takeaways: [{ source: 'photo', text: 'From photo: redness area noted', issue_type: 'redness' }],
    },
    language: 'EN',
    usedPhotos: false,
    photoQuality: { grade: 'unknown', reasons: [] },
    profileSummary: { goals: ['acne'] },
  });
  delete require.cache[moduleId];

  assert.ok(enriched.plan);
  assert.equal(typeof enriched.photo_notice, 'string');
  assert.match(enriched.photo_notice, /Based on your answers only \(photo not analyzed\)/);
  assert.ok(enriched.next_action_card && typeof enriched.next_action_card === 'object');
  assert.equal(Array.isArray(enriched.next_action_card.retake_guide), true);
  assert.equal(enriched.next_action_card.retake_guide.length, 3);
  assert.equal(Array.isArray(enriched.next_action_card.ask_3_questions), true);
  assert.equal(enriched.next_action_card.ask_3_questions.length, 3);
  assert.ok(Array.isArray(enriched.takeaways));
  assert.equal(enriched.takeaways.some((item) => item && item.source === 'photo'), false);
  const serialized = JSON.stringify(enriched).toLowerCase();
  assert.equal(/acne|pigmentation/.test(serialized), false);
});

test('buildExecutablePlanForAnalysis: used_photos=true links step why to photo finding ids', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal: auroraRouteInternals } = require('../src/auroraBff/routes');
  const enriched = auroraRouteInternals.buildExecutablePlanForAnalysis({
    analysis: {
      features: [{ observation: 'photo signal', confidence: 'somewhat_sure' }],
      strategy: 'placeholder?',
      photo_findings: [
        {
          finding_id: 'pf_redness',
          issue_type: 'redness',
          severity: 3,
          confidence: 0.82,
          evidence: 'From photo: cheek redness',
          computed_features: { red_fraction: 0.31 },
        },
      ],
      takeaways: [{ source: 'photo', issue_type: 'redness', text: 'From photo: redness in cheek area' }],
    },
    language: 'EN',
    usedPhotos: true,
    photoQuality: { grade: 'pass', reasons: [] },
    profileSummary: { goals: ['acne'] },
  });
  delete require.cache[moduleId];

  assert.ok(enriched.plan);
  assert.ok(Array.isArray(enriched.takeaways));
  assert.ok(enriched.takeaways.some((item) => item && item.source === 'photo'));
  assert.ok(
    enriched.takeaways.some((item) => Array.isArray(item?.linked_finding_ids) && item.linked_finding_ids.includes('pf_redness')),
  );
  const allSteps = [
    ...(enriched.plan.today?.am_steps || []),
    ...(enriched.plan.today?.pm_steps || []),
    ...(enriched.plan.today?.pause_now || []),
    ...(enriched.plan.next_7_days?.steps || []),
    ...(enriched.plan.after_calm?.steps || []),
  ];
  assert.ok(allSteps.some((step) => String(step?.why || '').includes('pf_redness')));
});

test('buildExecutablePlanForAnalysis: quality fail returns retake-only plan (no active steps)', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal: auroraRouteInternals } = require('../src/auroraBff/routes');
  const enriched = auroraRouteInternals.buildExecutablePlanForAnalysis({
    analysis: {
      features: [{ observation: 'retake needed', confidence: 'pretty_sure' }],
      strategy: 'placeholder?',
      takeaways: [{ source: 'photo', issue_type: 'quality', text: 'From photo: retake needed' }],
    },
    language: 'EN',
    usedPhotos: true,
    photoQuality: { grade: 'fail', reasons: ['blur'] },
    profileSummary: {},
  });
  delete require.cache[moduleId];

  assert.ok(enriched.plan);
  assert.equal(Array.isArray(enriched.plan.today?.am_steps), true);
  assert.equal(enriched.plan.today.am_steps.length, 0);
  assert.equal(Array.isArray(enriched.plan.today?.pm_steps), true);
  assert.equal(enriched.plan.today.pm_steps.length, 0);
  assert.ok(enriched.next_action_card && typeof enriched.next_action_card === 'object');
  assert.equal(Array.isArray(enriched.next_action_card.retake_guide), true);
  assert.equal(Array.isArray(enriched.next_action_card.ask_3_questions), true);
  const nextRules = Array.isArray(enriched.plan.next_7_days?.rules) ? enriched.plan.next_7_days.rules.join(' ') : '';
  assert.match(nextRules, /retake/i);
  const allSteps = [
    ...(enriched.plan.today?.pause_now || []),
    ...(enriched.plan.next_7_days?.steps || []),
    ...(enriched.plan.after_calm?.steps || []),
  ]
    .map((step) => `${step?.what || ''} ${step?.why || ''}`.toLowerCase())
    .join(' ');
  assert.equal(/retinoid|acid|vitamin c|niacinamide|exfoliat/.test(allSteps), false);
  const serialized = JSON.stringify(enriched).toLowerCase();
  assert.equal(/acne|pigmentation/.test(serialized), false);
});

test('Phase0 gate: no recos when profile is missing', async () => {
  const gate = shouldDiagnosisGate({
    message: 'Please recommend a moisturizer',
    triggerSource: 'text_explicit',
    profile: null,
  });
  assert.equal(gate.gated, true);
  assert.ok(gate.missing.includes('skinType'));

  const chips = buildDiagnosisChips('EN', gate.missing);
  assert.ok(chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
});

test('Recommendation gate: strips recommendation cards unless explicit', async () => {
  const filtered = stripRecommendationCards([
    { type: 'recommendations', payload: {} },
    { type: 'offers_resolved', payload: {} },
    { type: 'info', payload: { ok: true } },
  ]);
  assert.equal(filtered.some((c) => c.type === 'recommendations'), false);
  assert.equal(filtered.some((c) => c.type === 'offers_resolved'), false);
  assert.equal(filtered.some((c) => c.type === 'info'), true);
});

test('Dupe suggest: caches first result and serves from KB after', async () => {
  const routesId = require.resolve('../src/auroraBff/routes');
  delete require.cache[routesId];
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const headers = {
    'X-Aurora-Uid': 'uid_test_dupe_suggest',
    'X-Trace-ID': 'trace_test_dupe_suggest',
    'X-Brief-ID': 'brief_test_dupe_suggest',
    'X-Lang': 'EN',
  };

  const body = {
    original: { sku_id: 'mock_sku_dupe_suggest', brand: 'TestBrand', name: 'DUPE_SUGGEST_TEST Target Cleanser' },
    max_dupes: 2,
    max_comparables: 2,
  };

  const first = await supertest(app).post('/v1/dupe/suggest').set(headers).send(body).expect(200);
  assert.ok(Array.isArray(first.body.cards));
  const card1 = first.body.cards.find((c) => c && c.type === 'dupe_suggest');
  assert.ok(card1);
  assert.equal(card1.payload.meta.served_from_kb, false);
  assert.equal(card1.payload.meta.validated_now, true);
  assert.equal(card1.payload.verified, true);
  assert.ok(Array.isArray(card1.payload.dupes));
  assert.ok(Array.isArray(card1.payload.comparables));
  assert.ok(card1.payload.dupes.length <= 2);
  assert.ok(card1.payload.comparables.length <= 2);
  assert.ok(card1.payload.dupes.length >= 1);

  const second = await supertest(app).post('/v1/dupe/suggest').set(headers).send(body).expect(200);
  const card2 = second.body.cards.find((c) => c && c.type === 'dupe_suggest');
  assert.ok(card2);
  assert.equal(card2.payload.meta.served_from_kb, true);
  assert.equal(card2.payload.meta.validated_now, false);
  assert.equal(card2.payload.verified, true);
  assert.equal(card2.payload.kb_key, card1.payload.kb_key);

  // Avoid leaking cached route-level feature flags (env-derived) into later tests.
  delete require.cache[routesId];
});

test('State machine: PRODUCT_LINK_EVAL allows explicit recommendation transition', async () => {
  const validation = validateRequestedTransition({
    fromState: 'PRODUCT_LINK_EVAL',
    triggerSource: 'text_explicit',
    triggerId: 'recommend some product',
    requestedNextState: 'RECO_GATE',
  });
  assert.equal(validation.ok, true);
  if (validation.ok) assert.equal(validation.next_state, 'RECO_GATE');
});

test('Recommendation gate: clarification chips continue recommendation flow in RECO state', async () => {
  const allowed = recommendationsAllowed({
    triggerSource: 'chip',
    actionId: 'chip.clarify.skin_type.Oily',
    clarificationId: 'skin_type',
    message: 'Oily',
    state: 'S7_PRODUCT_RECO',
    agentState: 'RECO_GATE',
  });
  assert.equal(allowed, true);
});

test('Routine simulate: detects retinoid x acids conflict', async () => {
  const sim = simulateConflicts({
    routine: { pm: [{ key_actives: ['retinol'] }] },
    testProduct: { key_actives: ['glycolic acid'] },
  });
  assert.equal(sim.safe, false);
  assert.equal(sim.conflicts.some((c) => c.rule_id === 'retinoid_x_acids'), true);
});

test('Conflict heatmap V1: retinoid_x_acids maps to severity 3 at (1,2)', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: {
      schema_version: 'aurora.conflicts.v1',
      safe: false,
      conflicts: [{ severity: 'block', rule_id: 'retinoid_x_acids', message: 'x', step_indices: [1, 2] }],
      summary: 'x',
    },
    routineSteps: ['AM Cleanser', 'PM Treatment', 'PM Moisturizer'],
  });

  assert.equal(payload.schema_version, 'aurora.ui.conflict_heatmap.v1');
  assert.equal(payload.state, 'has_conflicts');
  assert.equal(payload.cells.encoding, 'sparse');
  assert.equal(payload.cells.default_severity, 0);
  assert.ok(Array.isArray(payload.cells.items));
  assert.equal(payload.cells.items.length, 1);
  assert.deepEqual(payload.cells.items[0], {
    cell_id: 'cell_1_2',
    row_index: 1,
    col_index: 2,
    severity: 3,
    rule_ids: ['retinoid_x_acids'],
    headline_i18n: { en: 'Retinoid × acids', zh: '维A类 × 酸类' },
    why_i18n: {
      en: 'Using retinoids with AHAs/BHAs in the same routine can significantly increase irritation and barrier stress.',
      zh: '维A类与 AHA/BHA 同晚叠加更容易刺激、爆皮，并加重屏障压力。',
    },
    recommendations: payload.cells.items[0].recommendations,
  });
  assert.ok(Array.isArray(payload.cells.items[0].recommendations));
  assert.ok(payload.cells.items[0].recommendations.length > 0);
  assert.ok(payload.cells.items[0].recommendations.every((r) => typeof r?.en === 'string' && typeof r?.zh === 'string'));
});

test('Conflict heatmap V1: multiple_exfoliants maps to severity 2 at (1,2)', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: {
      schema_version: 'aurora.conflicts.v1',
      safe: false,
      conflicts: [{ severity: 'warn', rule_id: 'multiple_exfoliants', message: 'x', step_indices: [2, 1] }],
      summary: 'x',
    },
    routineSteps: ['AM Cleanser', 'PM Treatment', 'PM Moisturizer'],
  });

  assert.equal(payload.state, 'has_conflicts');
  assert.equal(payload.cells.items.length, 1);
  assert.equal(payload.cells.items[0].cell_id, 'cell_1_2');
  assert.equal(payload.cells.items[0].severity, 2);
  assert.deepEqual(payload.cells.items[0].rule_ids, ['multiple_exfoliants']);
});

test('Conflict heatmap V1: safe + no conflicts -> no_conflicts', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: { safe: true, conflicts: [], summary: 'ok' },
    routineSteps: ['AM Cleanser', 'PM Moisturizer'],
  });

  assert.equal(payload.state, 'no_conflicts');
  assert.equal(Array.isArray(payload.cells.items), true);
  assert.equal(payload.cells.items.length, 0);
  assert.equal(Array.isArray(payload.unmapped_conflicts), true);
  assert.equal(payload.unmapped_conflicts.length, 0);
});

test('Conflict heatmap V1: missing step pair -> unmapped_conflicts + partial state', async () => {
  const payload = buildConflictHeatmapV1({
    routineSimulation: {
      schema_version: 'aurora.conflicts.v1',
      safe: false,
      conflicts: [{ severity: 'warn', rule_id: 'multiple_exfoliants', message: 'x' }],
      summary: 'x',
    },
    routineSteps: ['AM Cleanser', 'PM Treatment', 'PM Moisturizer'],
  });

  assert.equal(payload.state, 'has_conflicts_partial');
  assert.equal(payload.cells.items.length, 0);
  assert.equal(payload.unmapped_conflicts.length, 1);
  assert.equal(payload.unmapped_conflicts[0].rule_id, 'multiple_exfoliants');
  assert.equal(payload.unmapped_conflicts[0].severity, 2);
  assert.ok(payload.unmapped_conflicts[0].message_i18n);
});

test('/v1/routine/simulate: emits conflict_heatmap payload when enabled', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/routine/simulate', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        routine: { pm: [{ key_actives: ['retinol'], step: 'Treatment' }] },
        test_product: { key_actives: ['glycolic acid'], name: 'Test Acid' },
      },
    });

    assert.equal(resp.status, 200);
    assert.ok(Array.isArray(resp.body?.cards));
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.equal(heatmap.payload.cells.items[0].severity, 2);

    const impression = Array.isArray(resp.body?.events)
      ? resp.body.events.find((e) => e && e.event_name === 'aurora_conflict_heatmap_impression')
      : null;
    assert.ok(impression);
    assert.equal(impression?.data?.state, heatmap.payload.state);
  });
});

test('/v1/chat: compatibility question short-circuits to routine_simulation + conflict_heatmap', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        message: 'My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const sim = cards.find((c) => c && c.type === 'routine_simulation');
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(sim);
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.ok(Array.isArray(resp.body?.events));
    assert.ok(resp.body.events.some((e) => e && e.event_name === 'aurora_conflict_heatmap_impression'));
  });
});

test('/v1/chat: CN compatibility question (CN actives) short-circuits to routine_simulation + conflict_heatmap', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '阿达帕林/维A + 果酸同晚叠加可以吗？',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const sim = cards.find((c) => c && c.type === 'routine_simulation');
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(sim);
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(resp.body?.events));
    assert.ok(resp.body.events.some((e) => e && e.event_name === 'aurora_conflict_heatmap_impression'));
  });
});

test('/v1/chat: CN compatibility question (spaced CN actives) still short-circuits to routine_simulation + conflict_heatmap', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '我晚上会用 阿达 帕林/维 A 类。还能和 果酸 同晚 叠加可以吗？',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const sim = cards.find((c) => c && c.type === 'routine_simulation');
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(sim);
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(resp.body?.events));
    assert.ok(resp.body.events.some((e) => e && e.event_name === 'aurora_conflict_heatmap_impression'));
  });
});

test('/v1/chat: conflict question ignores profile.currentRoutine without actives (uses minimal pair)', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    // Seed a routine skeleton that has steps but no actives; the chat conflict check should not rely on it.
    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        currentRoutine: {
          am: [{ step: 'Cleanser' }, { step: 'Treatment' }, { step: 'Moisturizer' }, { step: 'SPF' }],
          pm: [{ step: 'Cleanser' }, { step: 'Treatment' }, { step: 'Moisturizer' }],
        },
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        message: 'My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.axes?.rows?.items));
    assert.equal(heatmap.payload.axes.rows.items.length, 2);
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.ok(heatmap.payload.cells.items[0].rule_ids.includes('retinoid_x_acids'));
  });
});

test('/v1/chat: conflict question ignores profile.currentRoutine even when it includes actives (uses minimal pair)', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    // Seed a routine that *does* include retinoid actives; ad-hoc conflict questions should still use a minimal pair.
    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        currentRoutine: {
          am: [{ step: 'Cleanser' }, { step: 'Moisturizer' }, { step: 'SPF' }],
          pm: [{ step: 'Treatment', key_actives: ['retinol'] }],
        },
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        message: 'My PM treatment is retinol. Can I add a glycolic acid toner? Check conflicts.',
        client_state: 'RECO_RESULTS',
        session: { state: 'S7_PRODUCT_RECO' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
    assert.equal(heatmap?.payload?.state, 'has_conflicts');
    assert.ok(Array.isArray(heatmap?.payload?.axes?.rows?.items));
    assert.equal(heatmap.payload.axes.rows.items.length, 2);
    assert.ok(Array.isArray(heatmap?.payload?.cells?.items));
    assert.equal(heatmap.payload.cells.items.length, 1);
    assert.ok(heatmap.payload.cells.items[0].rule_ids.includes('retinoid_x_acids'));
  });
});

test('Skin LLM policy: quality fail skips all LLM calls', async () => {
  const profiler = createStageProfiler();
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    detectorConfidenceLevel: 'low',
    visionAvailable: true,
    reportAvailable: true,
    degradedMode: 'report',
    quality: { grade: 'fail', reasons: ['qc_failed'] },
  };

  const visionDecision = shouldCallLlm({ ...base, kind: 'vision' });
  const reportDecision = shouldCallLlm({ ...base, kind: 'report' });

  assert.equal(visionDecision.decision, 'skip');
  assert.equal(reportDecision.decision, 'skip');

  if (visionDecision.decision === 'call') {
    await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'vision' }, async () => ({ ok: true }));
  }
  if (reportDecision.decision === 'call') {
    await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'report' }, async () => ({ ok: true }));
  }

  const report = profiler.report();
  assert.equal(report.llm_summary.calls, 0);
});

test('Skin LLM policy: degraded calls only one model (configurable)', async () => {
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    detectorConfidenceLevel: 'low',
    visionAvailable: true,
    reportAvailable: true,
    quality: { grade: 'degraded', reasons: ['qc_degraded'] },
  };

  {
    const profiler = createStageProfiler();
    const visionDecision = shouldCallLlm({ ...base, kind: 'vision', degradedMode: 'report' });
    const reportDecision = shouldCallLlm({ ...base, kind: 'report', degradedMode: 'report' });

    assert.equal(visionDecision.decision, 'skip');
    assert.equal(reportDecision.decision, 'call');
    assert.equal(reportDecision.downgrade_confidence, true);

    if (visionDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'vision' }, async () => ({ ok: true }));
    }
    if (reportDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'report' }, async () => ({ ok: true }));
    }
    const report = profiler.report();
    assert.equal(report.llm_summary.calls, 1);
  }

  {
    const profiler = createStageProfiler();
    const visionDecision = shouldCallLlm({ ...base, kind: 'vision', degradedMode: 'vision' });
    const reportDecision = shouldCallLlm({ ...base, kind: 'report', degradedMode: 'vision' });

    assert.equal(visionDecision.decision, 'call');
    assert.equal(reportDecision.decision, 'skip');
    assert.equal(visionDecision.downgrade_confidence, true);

    if (visionDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'vision' }, async () => ({ ok: true }));
    }
    if (reportDecision.decision === 'call') {
      await profiler.timeLlmCall({ provider: 'test', model: 'mock', kind: 'report' }, async () => ({ ok: true }));
    }
    const report = profiler.report();
    assert.equal(report.llm_summary.calls, 1);
  }
});

test('Skin LLM policy: pass skips report when detector is confident', async () => {
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    visionAvailable: true,
    reportAvailable: true,
    degradedMode: 'report',
    quality: { grade: 'pass', reasons: ['qc_passed'] },
  };

  const reportDecision = shouldCallLlm({ ...base, kind: 'report', detectorConfidenceLevel: 'high' });
  assert.equal(reportDecision.decision, 'skip');

  const reportDecisionUncertain = shouldCallLlm({ ...base, kind: 'report', detectorConfidenceLevel: 'low' });
  assert.equal(reportDecisionUncertain.decision, 'call');
});

test('Skin LLM policy: explicit uncertainty flag tightens LLM calls on pass quality', async () => {
  const base = {
    hasPrimaryInput: true,
    userRequestedPhoto: true,
    visionAvailable: true,
    reportAvailable: true,
    degradedMode: 'report',
    quality: { grade: 'pass', reasons: ['qc_passed'] },
  };

  // If deterministic policy says "not uncertain", skip even if the confidence level is not "high".
  const reportSkip = shouldCallLlm({
    ...base,
    kind: 'report',
    detectorConfidenceLevel: 'low',
    uncertainty: false,
  });
  assert.equal(reportSkip.decision, 'skip');

  // If deterministic policy says "uncertain", allow calling even when confidence level is high.
  const reportCall = shouldCallLlm({
    ...base,
    kind: 'report',
    detectorConfidenceLevel: 'high',
    uncertainty: true,
  });
  assert.equal(reportCall.decision, 'call');

  // Vision LMM should also be skippable when detector is confident and explicitly not uncertain.
  const visionSkip = shouldCallLlm({
    ...base,
    kind: 'vision',
    detectorConfidenceLevel: 'high',
    uncertainty: false,
  });
  assert.equal(visionSkip.decision, 'skip');
});

test('Diag rollout: bucket is stable and within 0..99', async () => {
  const a = hashToBucket0to99('req_abc');
  const b = hashToBucket0to99('req_abc');
  assert.equal(a, b);
  assert.equal(a >= 0 && a < 100, true);
});

test('Diag rollout: DIAG_PIPELINE_VERSION overrides canary', async () => {
  withEnv(
    {
      DIAG_PIPELINE_VERSION: 'v2',
      DIAG_SHADOW_MODE: 'false',
      DIAG_CANARY_PERCENT: '0',
      LLM_KILL_SWITCH: 'false',
    },
    () => {
      const d = getDiagRolloutDecision({ requestId: 'req_any' });
      assert.equal(d.selectedVersion, 'v2');
      assert.equal(d.reason, 'forced');
      assert.equal(d.shadowMode, false);
      assert.equal(d.llmKillSwitch, false);
    },
  );
});

test('Diag rollout: canary percent selects v2', async () => {
  withEnv({ DIAG_PIPELINE_VERSION: '', DIAG_CANARY_PERCENT: '100', DIAG_SHADOW_MODE: 'true', LLM_KILL_SWITCH: 'true' }, () => {
    const d = getDiagRolloutDecision({ requestId: 'req_any' });
    assert.equal(d.selectedVersion, 'v2');
    assert.equal(d.reason, 'canary');
    assert.equal(d.shadowMode, true);
    assert.equal(d.llmKillSwitch, true);
  });

  withEnv({ DIAG_PIPELINE_VERSION: '', DIAG_CANARY_PERCENT: '0', DIAG_SHADOW_MODE: 'false', LLM_KILL_SWITCH: 'false' }, () => {
    const d = getDiagRolloutDecision({ requestId: 'req_any' });
    assert.equal(d.selectedVersion, 'legacy');
    assert.equal(d.reason, 'default');
  });
});

test('Aurora mock: returns recommendations card (for offline gating tests)', async () => {
  const resp = await auroraChat({ baseUrl: '', query: 'Hello' });
  assert.ok(resp);
  assert.equal(Array.isArray(resp.cards), true);
  assert.equal(resp.cards.some((c) => String(c.type).includes('recommend')), true);
});

test('normalizeRecoGenerate: moves warning-like codes into warnings', async () => {
  const norm = normalizeRecoGenerate({
    recommendations: [{ slot: 'other', step: 'serum', sku: { brand: 'X', name: 'Y', sku_id: 'id' } }],
    evidence: null,
    confidence: 0.5,
    missing_info: ['over_budget', 'budget_unknown', 'recent_logs_missing'],
  });

  assert.ok(norm);
  assert.equal(Array.isArray(norm.payload.missing_info), true);
  assert.equal(Array.isArray(norm.payload.warnings), true);
  assert.equal(norm.payload.missing_info.includes('budget_unknown'), true);
  assert.equal(norm.payload.missing_info.includes('over_budget'), false);
  assert.equal(norm.payload.warnings.includes('over_budget'), true);
  assert.equal(norm.payload.warnings.includes('recent_logs_missing'), true);
});

test('Recommendation gate: does not unlock commerce for diagnosis chip', async () => {
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip.start.diagnosis', message: 'Start skin diagnosis' }),
    false,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip_get_recos', message: '' }),
    true,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip.start.routine', message: 'Build an AM/PM routine' }),
    true,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'chip', actionId: 'chip.start.dupes', message: 'Find dupes' }),
    true,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'text_explicit', actionId: null, message: 'Start skin diagnosis' }),
    false,
  );
  assert.equal(
    recommendationsAllowed({ triggerSource: 'text_explicit', actionId: null, message: 'Recommend a moisturizer' }),
    true,
  );
  assert.equal(
    recommendationsAllowed({
      triggerSource: 'chip',
      actionId: 'chip.clarify.budget.¥500',
      clarificationId: 'budget',
      message: '¥500',
      state: 'idle',
    }),
    false,
  );
  assert.equal(
    recommendationsAllowed({
      triggerSource: 'chip',
      actionId: 'chip.clarify.budget.¥500',
      clarificationId: 'budget',
      message: '¥500',
      state: 'S6_BUDGET',
    }),
    true,
  );
  assert.equal(
    recommendationsAllowed({
      triggerSource: 'chip',
      actionId: 'chip.clarify.budget.¥500',
      clarificationId: 'budget',
      message: '¥500',
      state: 'idle',
      clientState: 'RECO_GATE',
    }),
    false,
  );
  assert.equal(stateChangeAllowed('text_explicit'), true);
});

test('/v1/chat: Start diagnosis chip enters diagnosis flow (no upstream loop)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: {
      action: { action_id: 'chip.start.diagnosis', kind: 'chip', data: { reply_text: 'Start skin diagnosis' } },
      session: { state: 'idle' },
      language: 'EN',
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /quick skin profile/i);
  assert.equal(Array.isArray(resp.body?.suggested_chips), true);
  assert.ok(resp.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
  assert.ok(resp.body.suggested_chips.every((c) => !String(c.chip_id).startsWith('chip.clarify.next.')));
});

test('/v1/chat: Start diagnosis (EN keywords) triggers diagnosis flow even when lang=CN', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_diag_text_cn', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
    body: {
      message: 'Start diagnosis',
      session: { state: 'idle' },
      language: 'CN',
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /肤况确认|避免瞎猜/);
  assert.equal(Array.isArray(resp.body?.suggested_chips), true);
  assert.ok(resp.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
});

test('/v1/chat: Start diagnosis (CN keywords) still triggers diagnosis flow (lang=CN)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_diag_text_cn_2', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
    body: {
      message: '开始皮肤诊断',
      session: { state: 'idle' },
      language: 'CN',
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /肤况确认|避免瞎猜/);
  assert.equal(Array.isArray(resp.body?.suggested_chips), true);
  assert.ok(resp.body.suggested_chips.some((c) => String(c.chip_id).startsWith('profile.skinType.')));
});

test('/v1/chat: profile patch chips do not force diagnosis flow', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_profile_patch_idle', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
    body: {
      action: { action_id: 'profile.skinType.oily', kind: 'chip', data: { profile_patch: { skinType: 'oily' } } },
      session: { state: 'idle' },
      language: 'CN',
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  assert.equal(cards.some((c) => c && c.type === 'diagnosis_gate'), false);
  assert.ok(cards.some((c) => c && c.type === 'profile'));
});

test('/v1/chat: session.profile snapshot is included in upstream prefix (prevents re-asking known fields)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await supertest(app)
    .post('/v1/chat')
    .set({ 'X-Aurora-UID': 'test_uid_session_profile_prefix', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
    .send({
      message: 'CHAT_PROFILE_PREFIX_ECHO_TEST',
      session: { state: 'idle', profile: { skinType: 'oily' } },
      language: 'EN',
    })
    .expect(200);

  const content = String(resp.body?.assistant_message?.content || '');
  assert.ok(content.includes('"skinType":"oily"'));
});

test('/v1/chat: known skinType filters upstream skin_type clarification question (no chips emitted)', async () => {
  resetVisionMetrics();
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await supertest(app)
    .post('/v1/chat')
    .set({ 'X-Aurora-UID': 'test_uid_clar_filter_skin_only', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
    .send({
      message: 'CLARIFICATION_FILTER_SKINTYPE_ONLY_TEST',
      session: { state: 'idle', profile: { skinType: 'oily' } },
      language: 'EN',
    })
    .expect(200);

  const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
  assert.equal(chips.length, 0);
  assert.equal(chips.some((c) => String(c?.chip_id || '').startsWith('chip.clarify.skin_type.')), false);

  const snap = snapshotVisionMetrics();
  assert.equal(getLabeledCounterValue(snap.clarificationPresent, { present: 'true' }), 1);
  assert.equal(getLabeledCounterValue(snap.clarificationQuestionFiltered, { field: 'skintype' }), 1);
  assert.equal(Number(snap.clarificationAllQuestionsFilteredCount || 0), 1);
});

test('/v1/chat: when first clarification question is filtered, BFF uses next remaining clarification question', async () => {
  resetVisionMetrics();
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await supertest(app)
    .post('/v1/chat')
    .set({ 'X-Aurora-UID': 'test_uid_clar_filter_next', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
    .send({
      message: 'CLARIFICATION_FILTER_SKINTYPE_NEXT_TEST',
      session: { state: 'idle', profile: { skinType: 'oily' } },
      language: 'EN',
    })
    .expect(200);

  const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
  assert.ok(chips.length > 0);
  assert.ok(chips.some((c) => String(c?.chip_id || '').startsWith('chip.clarify.next.')));
  assert.equal(chips.some((c) => String(c?.chip_id || '').startsWith('chip.clarify.skin_type.')), false);

  const snap = snapshotVisionMetrics();
  assert.equal(getLabeledCounterValue(snap.clarificationPresent, { present: 'true' }), 1);
  assert.equal(getLabeledCounterValue(snap.clarificationQuestionFiltered, { field: 'skintype' }), 1);
  assert.equal(Number(snap.clarificationAllQuestionsFilteredCount || 0), 0);
});

test('/v1/chat: invalid upstream clarification shape does not throw and emits no chips', async () => {
  resetVisionMetrics();
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await supertest(app)
    .post('/v1/chat')
    .set({ 'X-Aurora-UID': 'test_uid_clar_invalid_shape', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
    .send({
      message: 'CLARIFICATION_FILTER_INVALID_OPTIONS_TEST',
      session: { state: 'idle' },
      language: 'EN',
    })
    .expect(200);

  const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
  assert.equal(chips.length, 0);

  const snap = snapshotVisionMetrics();
  assert.equal(getLabeledCounterValue(snap.clarificationPresent, { present: 'true' }), 1);
  assert.equal(getLabeledCounterValue(snap.clarificationSchemaInvalid, { reason: 'question_options_not_array' }), 1);
});

test('/v1/chat: clarification flow v2 advances local steps then resumes upstream once with root message + history', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp1 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_v2_start', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_TWO_QUESTIONS_TEST',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const chips1 = Array.isArray(resp1.body?.suggested_chips) ? resp1.body.suggested_chips : [];
        assert.ok(chips1.length > 0);
        assert.ok(chips1.some((c) => String(c?.chip_id || '').startsWith('chip.clarify.skin_type.')));

        const pending1 = resp1.body?.session_patch?.state?.pending_clarification;
        assert.ok(pending1);
        assert.equal(pending1.resume_user_text, 'CLARIFICATION_FLOW_V2_TWO_QUESTIONS_TEST');
        assert.equal(Array.isArray(pending1.queue), true);
        assert.equal(pending1.queue.length, 1);
        assert.equal(String(pending1.queue[0]?.id || ''), 'goals');
        assert.equal(Array.isArray(pending1.history), true);
        assert.equal(pending1.history.length, 0);

        const chip1 = chips1[0];
        const resp2 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_v2_start', 'X-Trace-ID': 'test_trace2', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip1.chip_id,
              kind: 'chip',
              data: chip1.data,
            },
            session: { state: { pending_clarification: pending1 } },
            language: 'EN',
          })
          .expect(200);

        const chips2 = Array.isArray(resp2.body?.suggested_chips) ? resp2.body.suggested_chips : [];
        assert.ok(chips2.length > 0);
        assert.ok(chips2.some((c) => String(c?.chip_id || '').startsWith('chip.clarify.goals.')));
        const cards2 = Array.isArray(resp2.body?.cards) ? resp2.body.cards : [];
        assert.equal(cards2.length, 0);

        const pending2 = resp2.body?.session_patch?.state?.pending_clarification;
        assert.ok(pending2);
        assert.equal(Array.isArray(pending2.history), true);
        assert.equal(pending2.history.length, 1);
        assert.equal(String(pending2.history[0]?.question_id || ''), 'skin_type');

        const snapAfterStep = snapshotVisionMetrics();
        assert.equal(getUpstreamCallTotal(snapAfterStep.upstreamCalls, { path: 'aurora_chat' }), 1);
        assert.equal(getLabeledCounterValue(snapAfterStep.auroraChatSkipped, { reason: 'pending_clarification_step' }), 1);
        assert.equal(getLabeledCounterValue(snapAfterStep.pendingClarificationStep, { step_index: '1' }), 1);

        const chip2 = chips2[0];
        const resp3 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_v2_start', 'X-Trace-ID': 'test_trace3', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip2.chip_id,
              kind: 'chip',
              data: chip2.data,
            },
            session: { state: { pending_clarification: pending2 } },
            language: 'EN',
          })
          .expect(200);

        const text3 = String(resp3.body?.assistant_message?.content || '');
        assert.match(text3, /history context/i);
        assert.equal(resp3.body?.session_patch?.state?.pending_clarification, null);

        const snap = snapshotVisionMetrics();
        assert.equal(getUpstreamCallTotal(snap.upstreamCalls, { path: 'aurora_chat' }), 2);
        assert.equal(Number(snap.pendingClarificationCompletedCount || 0), 1);
        assert.equal(getLabeledCounterValue(snap.clarificationHistorySent, { count: '2' }), 1);
        assert.equal(Number(snap.clarificationFlowV2StartedCount || 0), 1);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: clarification flow v2 resume injects resume prefix when enabled', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
      AURORA_CHAT_RESUME_PREFIX_V1: 'true',
      AURORA_CHAT_RESUME_PREFIX_V2: 'false',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp1 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_on', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_RESUME_ECHO_TEST',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);
        const pending1 = resp1.body?.session_patch?.state?.pending_clarification;
        const chip1 = Array.isArray(resp1.body?.suggested_chips) ? resp1.body.suggested_chips[0] : null;
        assert.ok(pending1);
        assert.ok(chip1);

        const resp2 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_on', 'X-Trace-ID': 'test_trace2', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip1.chip_id,
              kind: 'chip',
              data: chip1.data,
            },
            session: { state: { pending_clarification: pending1 } },
            language: 'EN',
          })
          .expect(200);
        const pending2 = resp2.body?.session_patch?.state?.pending_clarification;
        const chip2 = Array.isArray(resp2.body?.suggested_chips) ? resp2.body.suggested_chips[0] : null;
        assert.ok(pending2);
        assert.ok(chip2);

        const resp3 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_on', 'X-Trace-ID': 'test_trace3', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip2.chip_id,
              kind: 'chip',
              data: chip2.data,
            },
            session: { state: { pending_clarification: pending2 } },
            language: 'EN',
          })
          .expect(200);

        const resumeQuery = String(resp3.body?.assistant_message?.content || '');
        assert.match(resumeQuery, /\[RESUME CONTEXT\]/i);
        assert.match(resumeQuery, /Original user request:\s*"CLARIFICATION_FLOW_V2_RESUME_ECHO_TEST"/i);
        assert.match(resumeQuery, /Clarification answers \(in order\):/i);
        assert.match(resumeQuery, /- skin_type:/i);
        assert.match(resumeQuery, /Instruction:\s*Do not ask for these clarifications again\./i);

        const snap = snapshotVisionMetrics();
        assert.equal(getLabeledCounterValue(snap.resumePrefixInjected, { enabled: 'true' }), 1);
        assert.equal(getLabeledCounterValue(snap.resumePrefixHistoryItems, { count: '2' }), 1);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: clarification flow v2 resume injects authoritative resume prefix v2 when enabled', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
      AURORA_CHAT_RESUME_PREFIX_V1: 'true',
      AURORA_CHAT_RESUME_PREFIX_V2: 'true',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp1 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_v2_on', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_RESUME_ECHO_TEST',
            session: { state: 'idle', profile: { sensitivity: 'high' } },
            language: 'EN',
          })
          .expect(200);
        const pending1 = resp1.body?.session_patch?.state?.pending_clarification;
        const chip1 = Array.isArray(resp1.body?.suggested_chips) ? resp1.body.suggested_chips[0] : null;
        assert.ok(pending1);
        assert.ok(chip1);

        const resp2 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_v2_on', 'X-Trace-ID': 'test_trace2', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip1.chip_id,
              kind: 'chip',
              data: chip1.data,
            },
            session: { state: { pending_clarification: pending1 } },
            language: 'EN',
          })
          .expect(200);
        const pending2 = resp2.body?.session_patch?.state?.pending_clarification;
        const chip2 = Array.isArray(resp2.body?.suggested_chips) ? resp2.body.suggested_chips[0] : null;
        assert.ok(pending2);
        assert.ok(chip2);

        const resp3 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_v2_on', 'X-Trace-ID': 'test_trace3', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip2.chip_id,
              kind: 'chip',
              data: chip2.data,
            },
            session: { state: { pending_clarification: pending2 } },
            language: 'EN',
          })
          .expect(200);

        const resumeQuery = String(resp3.body?.assistant_message?.content || '');
        assert.match(resumeQuery, /AUTHORITATIVE/i);
        assert.match(resumeQuery, /Original user request \(answer this\):\s*"CLARIFICATION_FLOW_V2_RESUME_ECHO_TEST"/i);
        assert.match(resumeQuery, /Profile fields now known/i);
        assert.match(resumeQuery, /ask at most ONE new question/i);
        assert.match(resumeQuery, /- goals = "acne"/i);

        const snap = snapshotVisionMetrics();
        assert.equal(getLabeledCounterValue(snap.resumePrefixInjected, { enabled: 'true' }), 1);
        assert.equal(getLabeledCounterValue(snap.resumePrefixHistoryItems, { count: '2' }), 1);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: resume prefix is absent when AURORA_CHAT_RESUME_PREFIX_V1=false while history context is still sent', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
      AURORA_CHAT_RESUME_PREFIX_V1: 'false',
      AURORA_CHAT_RESUME_PREFIX_V2: 'false',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp1 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_off', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_RESUME_ECHO_TEST',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);
        const pending1 = resp1.body?.session_patch?.state?.pending_clarification;
        const chip1 = Array.isArray(resp1.body?.suggested_chips) ? resp1.body.suggested_chips[0] : null;
        assert.ok(pending1);
        assert.ok(chip1);

        const resp2 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_off', 'X-Trace-ID': 'test_trace2', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip1.chip_id,
              kind: 'chip',
              data: chip1.data,
            },
            session: { state: { pending_clarification: pending1 } },
            language: 'EN',
          })
          .expect(200);
        const pending2 = resp2.body?.session_patch?.state?.pending_clarification;
        const chip2 = Array.isArray(resp2.body?.suggested_chips) ? resp2.body.suggested_chips[0] : null;
        assert.ok(pending2);
        assert.ok(chip2);

        const resp3 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_resume_prefix_off', 'X-Trace-ID': 'test_trace3', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip2.chip_id,
              kind: 'chip',
              data: chip2.data,
            },
            session: { state: { pending_clarification: pending2 } },
            language: 'EN',
          })
          .expect(200);

        const resumeQuery = String(resp3.body?.assistant_message?.content || '');
        assert.doesNotMatch(resumeQuery, /\[RESUME CONTEXT\]/i);
        assert.match(resumeQuery, /clarification_history/i);

        const snap = snapshotVisionMetrics();
        assert.equal(getLabeledCounterValue(snap.resumePrefixInjected, { enabled: 'false' }), 1);
        assert.equal(getLabeledCounterValue(snap.resumePrefixHistoryItems, { count: '0' }), 1);
        assert.equal(getLabeledCounterValue(snap.clarificationHistorySent, { count: '2' }), 1);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: resume probe metrics detect intake-like resume output and do not run on ordinary turns', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
      AURORA_CHAT_RESUME_PREFIX_V1: 'true',
      AURORA_CHAT_RESUME_PREFIX_V2: 'false',
      AURORA_CHAT_RESUME_PROBE_METRICS: 'true',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp1 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_resume_probe_bad', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_RESUME_PROBE_BAD_TEST',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);
        const pending1 = resp1.body?.session_patch?.state?.pending_clarification;
        const chip1 = Array.isArray(resp1.body?.suggested_chips) ? resp1.body.suggested_chips[0] : null;
        assert.ok(pending1);
        assert.ok(chip1);

        const resp2 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_resume_probe_bad', 'X-Trace-ID': 'test_trace2', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip1.chip_id,
              kind: 'chip',
              data: chip1.data,
            },
            session: { state: { pending_clarification: pending1 } },
            language: 'EN',
          })
          .expect(200);
        const pending2 = resp2.body?.session_patch?.state?.pending_clarification;
        const chip2 = Array.isArray(resp2.body?.suggested_chips) ? resp2.body.suggested_chips[0] : null;
        assert.ok(pending2);
        assert.ok(chip2);

        const resp3 = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_resume_probe_bad', 'X-Trace-ID': 'test_trace3', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: chip2.chip_id,
              kind: 'chip',
              data: chip2.data,
            },
            session: { state: { pending_clarification: pending2 } },
            language: 'EN',
          })
          .expect(200);

        const badResumeText = String(resp3.body?.assistant_message?.content || '');
        assert.match(badResumeText, /quick skin profile/i);

        const snapAfterResume = snapshotVisionMetrics();
        const questionModeCount = getLabeledCounterValue(snapAfterResume.resumeResponseMode, { mode: 'question' });
        const reaskSkinType = getLabeledCounterValue(snapAfterResume.resumePlaintextReaskDetected, { field: 'skintype' });
        const reaskGoals = getLabeledCounterValue(snapAfterResume.resumePlaintextReaskDetected, { field: 'goals' });
        assert.equal(questionModeCount, 1);
        assert.ok(reaskSkinType >= 1 || reaskGoals >= 1);

        await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_resume_probe_non_resume', 'X-Trace-ID': 'test_trace4', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'RESUME_PROBE_NON_RESUME_BAD_TEXT_TEST',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const snapAfterOrdinary = snapshotVisionMetrics();
        assert.equal(getLabeledCounterValue(snapAfterOrdinary.resumeResponseMode, { mode: 'question' }), questionModeCount);
        assert.equal(
          getLabeledCounterValue(snapAfterOrdinary.resumePlaintextReaskDetected, { field: 'skintype' }),
          reaskSkinType,
        );
        assert.equal(
          getLabeledCounterValue(snapAfterOrdinary.resumePlaintextReaskDetected, { field: 'goals' }),
          reaskGoals,
        );
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: pending clarification is abandoned on free text and upstream is called with pending cleared', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const start = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_v2_free_text', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_TWO_QUESTIONS_TEST',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const pending = start.body?.session_patch?.state?.pending_clarification;
        assert.ok(pending);

        const resp = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_v2_free_text', 'X-Trace-ID': 'test_trace2', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_FREE_TEXT_CONTINUE_TEST',
            session: { state: { pending_clarification: pending } },
            language: 'EN',
          })
          .expect(200);

        assert.equal(resp.body?.session_patch?.state?.pending_clarification, null);
        const text = String(resp.body?.assistant_message?.content || '');
        assert.match(text, /free text after pending clarification abandon/i);

        const snap = snapshotVisionMetrics();
        assert.equal(getUpstreamCallTotal(snap.upstreamCalls, { path: 'aurora_chat' }), 2);
        assert.equal(getLabeledCounterValue(snap.pendingClarificationAbandoned, { reason: 'free_text' }), 1);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: pending clarification TTL expiry abandons state and continues upstream', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const stalePending = {
          created_at_ms: Date.now() - (11 * 60 * 1000),
          resume_user_text: 'CLARIFICATION_FLOW_V2_TWO_QUESTIONS_TEST',
          queue: [
            {
              id: 'goals',
              question: 'What is your top goal now?',
              options: ['Acne control', 'Barrier repair', 'Brightening'],
            },
          ],
          current: { id: 'skin_type', question: 'Which skin type fits you best?' },
          history: [],
        };

        const resp = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_flow_v2_ttl', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: 'CLARIFICATION_FLOW_V2_TTL_TEST',
            action: {
              action_id: 'chip.clarify.skin_type.Oily',
              kind: 'chip',
              data: {
                clarification_id: 'skin_type',
                clarification_question_id: 'skin_type',
                clarification_step: 1,
                reply_text: 'Oily',
              },
            },
            session: { state: { pending_clarification: stalePending } },
            language: 'EN',
          })
          .expect(200);

        const text = String(resp.body?.assistant_message?.content || '');
        assert.match(text, /ttl fallback to upstream/i);
        assert.equal(resp.body?.session_patch?.state?.pending_clarification, null);

        const snap = snapshotVisionMetrics();
        assert.equal(getUpstreamCallTotal(snap.upstreamCalls, { path: 'aurora_chat' }), 1);
        assert.equal(getLabeledCounterValue(snap.pendingClarificationAbandoned, { reason: 'ttl' }), 1);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: legacy pending_clarification upgrades to v1 and continues local step flow', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const legacyPending = {
          created_at_ms: Date.now(),
          resume_user_text: 'CLARIFICATION_FLOW_V2_TWO_QUESTIONS_TEST',
          current: { id: 'skin_type', question: 'Which skin type fits you best?' },
          queue: [
            {
              id: 'goals',
              question: 'What is your top goal now?',
              options: ['Acne control', 'Barrier repair', 'Brightening'],
            },
          ],
          history: [],
        };

        const resp = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_legacy_upgrade', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            action: {
              action_id: 'chip.clarify.skin_type.Oily',
              kind: 'chip',
              data: {
                clarification_id: 'skin_type',
                clarification_question_id: 'skin_type',
                clarification_step: 1,
                reply_text: 'Oily',
              },
            },
            session: { state: { pending_clarification: legacyPending } },
            language: 'EN',
          })
          .expect(200);

        const pending = resp.body?.session_patch?.state?.pending_clarification;
        assert.ok(pending);
        assert.equal(Number(pending.v), 1);
        assert.match(String(pending.flow_id || ''), /^pc_[a-z0-9]+$/i);
        assert.equal(Number(pending.step_index), 1);
        assert.equal(String(pending.current?.id || ''), 'goals');
        assert.equal(String(pending.current?.norm_id || ''), 'goals');
        assert.equal(Array.isArray(pending.history), true);
        assert.equal(pending.history.length, 1);
        assert.equal(String(pending.history[0]?.question_id || ''), 'skin_type');
        assert.equal(String(pending.history[0]?.norm_id || ''), 'skinType');

        const snap = snapshotVisionMetrics();
        assert.equal(getLabeledCounterValue(snap.pendingClarificationUpgraded, { from: 'legacy' }), 1);
        assert.equal(getUpstreamCallTotal(snap.upstreamCalls, { path: 'aurora_chat' }), 0);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: pending_clarification v1 emission is bounded and truncation metrics are recorded', async () => {
  resetVisionMetrics();
  await withEnv(
    {
      AURORA_CHAT_CLARIFICATION_FLOW_V2: 'true',
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT: 'true',
      AURORA_CHAT_CLARIFICATION_FILTER_KNOWN: 'true',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routesModuleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const overlongMessage = `CLARIFICATION_FLOW_V2_TRUNCATION_TEST ${'R'.repeat(1000)}`;
        const resp = await supertest(app)
          .post('/v1/chat')
          .set({ 'X-Aurora-UID': 'test_uid_clar_truncation', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' })
          .send({
            message: overlongMessage,
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const pending = resp.body?.session_patch?.state?.pending_clarification;
        assert.ok(pending);
        assert.equal(Number(pending.v), 1);
        assert.match(String(pending.flow_id || ''), /^pc_[a-z0-9]+$/i);
        assert.ok(String(pending.resume_user_text || '').length <= 800);
        assert.ok(Array.isArray(pending.queue));
        assert.ok(pending.queue.length <= 5);

        for (const q of pending.queue) {
          assert.ok(String(q?.question || '').length <= 200);
          assert.ok(Array.isArray(q?.options));
          assert.ok(q.options.length <= 8);
          assert.ok(typeof q?.norm_id === 'string' && q.norm_id.length > 0);
          for (const opt of q.options) {
            assert.ok(String(opt || '').length <= 80);
          }
        }

        const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
        assert.ok(chips.length <= 8);
        for (const chip of chips) {
          assert.ok(String(chip?.label || '').length <= 80);
        }

        const snap = snapshotVisionMetrics();
        assert.ok(getLabeledCounterValue(snap.pendingClarificationTruncated, { field: 'resume_user_text' }) >= 1);
        assert.ok(getLabeledCounterValue(snap.pendingClarificationTruncated, { field: 'question' }) >= 1);
        assert.ok(getLabeledCounterValue(snap.pendingClarificationTruncated, { field: 'option' }) >= 1);
        assert.ok(getLabeledCounterValue(snap.pendingClarificationTruncated, { field: 'queue' }) >= 1);
        assert.ok(getLabeledCounterValue(snap.pendingClarificationTruncated, { field: 'options' }) >= 1);
      } finally {
        delete require.cache[routesModuleId];
      }
    },
  );
});

test('/v1/chat: Routine alternatives cover AM + PM', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: {
      action: {
        action_id: 'chip.start.routine',
        kind: 'chip',
        data: {
          reply_text: 'Build an AM/PM routine',
          include_alternatives: true,
          profile_patch: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            goals: ['pores'],
            budgetTier: '¥500',
          },
        },
      },
      session: { state: 'S2_DIAGNOSIS' },
      language: 'EN',
    },
  });

  assert.equal(resp.status, 200);

  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const recoCard = cards.find((c) => c && c.type === 'recommendations');
  assert.ok(recoCard);

  const recos = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
  const am = recos.find((r) => String(r?.slot || '').toLowerCase() === 'am');
  const pm = recos.find((r) => String(r?.slot || '').toLowerCase() === 'pm');
  assert.ok(am);
  assert.ok(pm);

  assert.ok(Array.isArray(am.alternatives) && am.alternatives.length > 0);
  assert.ok(Array.isArray(pm.alternatives) && pm.alternatives.length > 0);
});

test('/v1/chat: strips internal kb: citations from recommendations (non-debug)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const baseBody = {
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
          budgetTier: '¥500',
        },
      },
    },
    session: { state: 'S2_DIAGNOSIS' },
    language: 'EN',
  };

  const respNoDebug = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_kb_strip_1', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: baseBody,
  });
  assert.equal(respNoDebug.status, 200);
  assert.equal(JSON.stringify(respNoDebug.body).includes('kb:'), false);

  const cardsNoDebug = Array.isArray(respNoDebug.body?.cards) ? respNoDebug.body.cards : [];
  const recoNoDebug = cardsNoDebug.find((c) => c && c.type === 'recommendations');
  assert.ok(recoNoDebug);
  const firstNoDebug = Array.isArray(recoNoDebug?.payload?.recommendations) ? recoNoDebug.payload.recommendations[0] : null;
  assert.ok(firstNoDebug);
  assert.ok(Array.isArray(firstNoDebug?.evidence_pack?.citations));
  assert.equal(firstNoDebug.evidence_pack.citations.length, 0);

  const respDebug = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_kb_strip_2', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Debug': 'true' },
    body: { ...baseBody, debug: true },
  });
  assert.equal(respDebug.status, 200);
  assert.equal(JSON.stringify(respDebug.body).includes('kb:'), true);

  const cardsDebug = Array.isArray(respDebug.body?.cards) ? respDebug.body.cards : [];
  const recoDebug = cardsDebug.find((c) => c && c.type === 'recommendations');
  assert.ok(recoDebug);
  const firstDebug = Array.isArray(recoDebug?.payload?.recommendations) ? recoDebug.payload.recommendations[0] : null;
  assert.ok(firstDebug);
  assert.ok(Array.isArray(firstDebug?.evidence_pack?.citations));
  assert.ok(firstDebug.evidence_pack.citations.some((c) => String(c).startsWith('kb:')));
});

test('/v1/chat: fit-check fallback emits product_analysis when upstream returns structured stub only', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_fallback', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        budgetTier: '¥500',
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_fallback', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '请诊断一下这款产品适不适合我：The Ordinary Niacinamide 10% + Zinc 1% (STRUCTURED_STUB_ONLY_TEST)',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.ok(cardTypes.includes('product_analysis'));
    const assistant = String(resp.body?.assistant_message?.content || '');
    assert.equal(/parse\/summary stub/i.test(assistant), false);
    assert.equal(assistant.includes('结论：'), true);
    assert.equal(assistant.includes('停用信号：'), true);
  });
});

test('/v1/chat: recommendation parse-stub answer is rewritten to reco route contract', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_INGREDIENT_PLAN_ENABLED: 'false',
    },
    async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_reco_route_rewrite', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening', 'acne'],
        budgetTier: '¥500',
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_reco_route_rewrite', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '请推荐产品 SHORT_CARDS_BELOW_STUB_TEST',
        action: { action_id: 'chip_get_recos', kind: 'chip', data: { trigger_source: 'chip' } },
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const assistant = String(resp.body?.assistant_message?.content || '');
    assert.equal(/parse\/summary stub/i.test(assistant), false);
    assert.equal(/structured cards below/i.test(assistant), false);
      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const cardTypes = cards.map((c) => c && c.type).filter(Boolean);
      const hasReco = cardTypes.includes('recommendations');
      const conf = cards.find((c) => c && c.type === 'confidence_notice') || null;
      assert.ok(hasReco || conf);
      if (hasReco) {
        assert.equal(assistant.includes('最小可行清单（早/晚）：') || assistant.includes('成分方向（Top 3）：'), true);
      }
      if (conf) {
        assert.equal(conf?.payload?.reason, 'artifact_missing');
      }
    },
  );
});

test('/v1/chat: fit-check non-generic parse stub is rewritten to fit-check contract', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_non_generic_stub', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        budgetTier: '¥500',
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_non_generic_stub', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '请评估这款产品是否适合我：The Ordinary Niacinamide 10% + Zinc 1% (NON_GENERIC_STUB_TEST)',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const assistant = String(resp.body?.assistant_message?.content || '');
    assert.equal(/结论：|Verdict:/i.test(assistant), true);
    assert.equal(/风险点：|Risk points:/i.test(assistant), true);
    assert.equal(/怎么用（频率\/顺序\/观察周期）：|How to use \(frequency\/order\/timeline\):/i.test(assistant), true);
  });
});

test('/v1/chat: fit-check bypasses the AM/PM budget gate when session.state=S6_BUDGET', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '这款适不适合我：The Ordinary Niacinamide 10% + Zinc 1% (STRUCTURED_STUB_ONLY_TEST)',
        session: { state: 'S6_BUDGET' },
        client_state: 'RECO_GATE',
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('budget_gate'), false);
    assert.ok(cardTypes.includes('product_analysis'));
    assert.equal(resp.body?.session_patch?.next_state, 'PRODUCT_LINK_EVAL');
    assert.equal(resp.body?.session_patch?.state?._internal_next_state, 'S7_PRODUCT_RECO');
  });
});

test('/v1/chat: compatibility bypasses the AM/PM budget gate when session.state=S6_BUDGET', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_compat_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_compat_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '我晚上会用阿达帕林/维A类。还能和果酸同晚叠加吗？怎么安排频率更安全？',
        session: { state: 'S6_BUDGET' },
        client_state: 'RECO_GATE',
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('budget_gate'), false);
    assert.ok(cardTypes.includes('routine_simulation'));
    assert.ok(cardTypes.includes('conflict_heatmap'));
    assert.equal(resp.body?.session_patch?.next_state, 'ROUTINE_REVIEW');
    assert.equal(resp.body?.session_patch?.state?._internal_next_state, 'S7_PRODUCT_RECO');
  });
});

test('/v1/chat: ingredient science bypasses budget gate in S6_BUDGET and asks science clarification first', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_science_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        region: 'US',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_science_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        message: 'I want ingredient science (evidence/mechanism), not product recommendations yet.',
        session: { state: 'S6_BUDGET' },
        client_state: 'RECO_GATE',
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('budget_gate'), false);
    const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
    const chipIds = chips.map((c) => String(c && c.chip_id || '')).filter(Boolean);
    assert.ok(chipIds.includes('chip.science.target.niacinamide'));
    assert.ok(chipIds.includes('chip.science.goal.acne'));
  });
});

test('/v1/chat: recommendation intent bypasses budget gate in S6_BUDGET (anti-aging)', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_INGREDIENT_PLAN_ENABLED: 'false',
    },
    async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_antiaging_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
        goals: ['wrinkles'],
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_antiaging_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '想做抗老，推荐温和一点的精华',
        session: { state: 'S6_BUDGET' },
        client_state: 'RECO_GATE',
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const cardTypes = cards.map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('budget_gate'), false);
    const conf = cards.find((c) => c && c.type === 'confidence_notice') || null;
    assert.ok(cardTypes.includes('recommendations') || conf);
    if (conf) {
      assert.equal(conf?.payload?.reason, 'artifact_missing');
    }
    },
  );
});

test('/v1/chat: budget clarification chip continues routine/reco flow when in S6_BUDGET', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_clarify_budget_reco', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
        goals: ['wrinkles'],
        region: 'US',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_clarify_budget_reco', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        action: {
          action_id: 'chip.clarify.budget.y500',
          kind: 'chip',
          data: { clarification_id: 'budget', reply_text: '¥500' },
        },
        message: '¥500',
        session: { state: 'S6_BUDGET' },
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.ok(cardTypes.includes('recommendations'));
    assert.equal(cardTypes.includes('budget_gate'), false);
    const assistantText = String(resp.body?.assistant_message?.content || '').toLowerCase();
    assert.equal(assistantText.includes('did not receive any renderable structured cards'), false);
  });
});

test('/v1/chat: stale budget-clarify chip outside budget flow returns next-step guidance (no parse-stub loop)', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_stale_budget_chip_idle', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
        goals: ['wrinkles'],
        region: 'CN',
        budgetTier: '¥500',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_stale_budget_chip_idle', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        action: {
          action_id: 'chip.clarify.budget.y500',
          kind: 'chip',
          data: { clarification_id: 'budget', reply_text: '¥500' },
        },
        message: '¥500',
        session: { state: 'idle' },
        client_state: 'IDLE_CHAT',
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('profile'), true);
    assert.equal(cardTypes.includes('recommendations'), false);
    const assistantText = String(resp.body?.assistant_message?.content || '').toLowerCase();
    assert.equal(assistantText.includes('did not receive any renderable structured cards'), false);
  });
});

test('/v1/chat: stale budget-clarify chip with client_state=RECO_GATE does not unlock recommendations', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_stale_budget_chip_reco_gate', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'healthy',
        goals: ['wrinkles'],
        region: 'CN',
        budgetTier: '¥500',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_stale_budget_chip_reco_gate', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        action: {
          action_id: 'chip.clarify.budget.y500',
          kind: 'chip',
          data: { clarification_id: 'budget', reply_text: '¥500' },
        },
        message: '¥500',
        session: { state: 'idle' },
        client_state: 'RECO_GATE',
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('profile'), true);
    assert.equal(cardTypes.includes('recommendations'), false);
    const assistantText = String(resp.body?.assistant_message?.content || '').toLowerCase();
    assert.equal(assistantText.includes('did not receive any renderable structured cards'), false);
  });
});

test('/v1/chat: evaluate intent without anchor asks for product name/link (no diagnosis loop)', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    resetVisionMetrics();
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'test_uid_evaluate_anchor_required',
        'X-Trace-ID': 'test_trace',
        'X-Brief-ID': 'test_brief',
        'X-Lang': 'EN',
      },
      body: {
        message: 'Evaluate a specific product for me',
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('diagnosis_gate'), false);
    assert.equal(cardTypes.includes('recommendations'), false);

    const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
    const chipIds = chips.map((c) => String(c?.chip_id || '')).filter(Boolean);
    assert.ok(chipIds.includes('chip.fitcheck.send_product_name'));
    assert.ok(chipIds.includes('chip.fitcheck.send_link'));

    const assistant = String(resp.body?.assistant_message?.content || '').toLowerCase();
    assert.equal(assistant.includes('product name'), true);
    assert.equal(assistant.includes('link'), true);

    const snap = snapshotVisionMetrics();
    const auroraChatCalls = (Array.isArray(snap.upstreamCalls) ? snap.upstreamCalls : []).filter(([key]) => {
      try {
        return JSON.parse(key).path === 'aurora_chat';
      } catch (_err) {
        return false;
      }
    });
    assert.equal(auroraChatCalls.length, 0);
  });
});

test('/v1/chat: fit-check ignores stale routine action_id (no budget gate)', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_stale_action', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_stale_action', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        // Stale chip/action from UI (routine), while the typed message is a fit-check.
        action: { action_id: 'chip.action.reco_routine', kind: 'chip', data: { reply_text: 'Build an AM/PM routine' } },
        client_state: 'RECO_GATE',
        message: '这款适不适合我：The Ordinary Niacinamide 10% + Zinc 1% (STRUCTURED_STUB_ONLY_TEST)',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('budget_gate'), false);
    assert.ok(cardTypes.includes('product_analysis'));
  });
});

test('/v1/chat: fit-check ignores stale budget-clarify action_id (no reco hijack)', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_stale_budget_chip', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        region: 'CN',
        budgetTier: '¥500',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_fit_check_stale_budget_chip', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        // Stale budget-clarify chip from previous turn; typed message is a fit-check and should win.
        action: {
          action_id: 'chip.clarify.budget.y500',
          kind: 'chip',
          data: { clarification_id: 'budget', reply_text: '¥500' },
        },
        client_state: 'RECO_GATE',
        message: '这款适不适合我：The Ordinary Niacinamide 10% + Zinc 1% (STRUCTURED_STUB_ONLY_TEST)',
        session: { state: 'S7_PRODUCT_RECO' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('budget_gate'), false);
    assert.equal(cardTypes.includes('recommendations'), false);
    assert.ok(cardTypes.includes('product_analysis'));
  });
});

test('/v1/chat: fit-check parse stub with reco card still emits fit-check analysis', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_fitcheck_reco_stub', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_fitcheck_reco_stub', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '这款适不适合我：The Ordinary Niacinamide 10% + Zinc 1% SHORT_CARDS_BELOW_STRIPPED_RECO_TEST',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('product_analysis'), true);

    const assistant = String(resp.body?.assistant_message?.content || '');
    assert.equal(/cards\s+below/i.test(assistant), false);
    assert.equal(assistant.includes('结论：'), true);
    assert.equal(assistant.includes('风险点：'), true);
  });
});

test('/v1/chat: fit-check without upstream analysis still backfills product_analysis', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_fitcheck_backfill', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['acne'],
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_fitcheck_backfill', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '这款适不适合我：The Ordinary Niacinamide 10% + Zinc 1%',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('product_analysis'), true);
    const assistant = String(resp.body?.assistant_message?.content || '');
    assert.equal(assistant.includes('结论：'), true);
  });
});

test('/v1/chat: anchor-derived product_analysis personalizes reasons using profile', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_anchor_personalize', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening', 'acne'],
        budgetTier: '¥500',
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_anchor_personalize', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '请评估：The Ordinary Niacinamide 10% + Zinc 1% (ANCHOR_CONTEXT_ONLY_TEST)',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const pa = cards.find((c) => c && c.type === 'product_analysis');
    assert.ok(pa);
    const reasons = Array.isArray(pa?.payload?.assessment?.reasons) ? pa.payload.assessment.reasons : [];
    const joined = reasons.join(' | ');
    assert.ok(joined.includes('油皮'));
    assert.ok(joined.includes('提亮') || joined.includes('痘'));
  });
});

test('enrichProductAnalysisPayload: adds profile-fit reasons and hides raw risk codes (CN)', () => {
  const { enrichProductAnalysisPayload } = require('../src/auroraBff/normalize');

  const payload = {
    assessment: {
      verdict: 'Caution',
      reasons: ['Some people experience flushing/tingling.', 'high_irritation', 'Targets: Brightening, Oil control'],
    },
    evidence: {
      science: {
        key_ingredients: ['Niacinamide', 'Zinc PCA'],
        mechanisms: [],
        fit_notes: [],
        risk_notes: ['high_irritation'],
      },
      social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
      expert_notes: [],
      confidence: 0.7,
      missing_info: [],
    },
    confidence: 0.7,
    missing_info: [],
  };

  const profileSummary = {
    skinType: 'oily',
    sensitivity: 'low',
    barrierStatus: 'healthy',
    goals: ['brightening', 'acne'],
    region: 'CN',
    budgetTier: '¥500',
    currentRoutine: null,
    itinerary: null,
    contraindications: [],
  };

  const out = enrichProductAnalysisPayload(payload, { lang: 'CN', profileSummary });
  const reasons = Array.isArray(out?.assessment?.reasons) ? out.assessment.reasons : [];
  const joined = reasons.join(' | ');
  // CN profile-fit reasons should be present and preferred over generic EN fallback text.
  assert.ok(reasons.some((r) => /^(匹配目标|你的情况)：/.test(String(r || ''))));
  assert.ok(reasons.some((r) => /^(匹配点|使用建议)：/.test(String(r || ''))));
  assert.ok(
    reasons.some((r) => String(r || '').startsWith('最关键成分：')) ||
      reasons.some((r) => /烟酰胺|niacinamide|锌/i.test(String(r || ''))),
  );
  assert.ok(joined.includes('油皮') || joined.includes('油脂'));
  assert.equal(joined.includes('high_irritation'), false);
  // CN flow should prefer CN reasons when available.
  assert.equal(/\bTargets:\b/i.test(joined), false);
});

test('/v1/chat: chip_get_recos gates when profile missing, then yields recommendations after profile saved', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_INGREDIENT_PLAN_ENABLED: 'false',
    },
    async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const headers = {
      'X-Aurora-UID': 'test_uid_chip_get_recos',
      'X-Trace-ID': 'test_trace',
      'X-Brief-ID': 'test_brief',
      'X-Lang': 'EN',
    };

    const resp1 = await invokeRoute(app, 'POST', '/v1/chat', {
      headers,
      body: {
        action: { action_id: 'chip_get_recos', kind: 'chip', data: { trigger_source: 'chip' } },
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(resp1.status, 200);
    const cards1 = Array.isArray(resp1.body?.cards) ? resp1.body.cards : [];
    assert.ok(cards1.some((c) => c && c.type === 'diagnosis_gate'));
    assert.equal(cards1.some((c) => c && c.type === 'recommendations'), false);

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers,
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['pores'],
      },
    });
    assert.equal(seed.status, 200);

    const resp2 = await invokeRoute(app, 'POST', '/v1/chat', {
      headers,
      body: {
        action: { action_id: 'chip_get_recos', kind: 'chip', data: { trigger_source: 'chip' } },
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(resp2.status, 200);
    const cards2 = Array.isArray(resp2.body?.cards) ? resp2.body.cards : [];
    const reco = cards2.find((c) => c && c.type === 'recommendations') || null;
    const conf = cards2.find((c) => c && c.type === 'confidence_notice') || null;
    assert.ok(reco || conf);
    if (reco) {
      const first = Array.isArray(reco?.payload?.recommendations) ? reco.payload.recommendations[0] : null;
      assert.ok(first);
    }
    if (conf) {
      assert.equal(conf?.payload?.reason, 'artifact_missing');
    }
    },
  );
});

test('/v1/chat: CN reco request yields recommendations (no conflict cards)', async () => {
  await withEnv(
    {
      AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
      AURORA_INGREDIENT_PLAN_ENABLED: 'false',
    },
    async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    // With no profile, diagnosis-first gating should happen before any recommendations.
    const respNoProfile = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_cn_reco_noprofile', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '要烟酰胺精华，最好温和点',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(respNoProfile.status, 200);
    const cardsNoProfile = Array.isArray(respNoProfile.body?.cards) ? respNoProfile.body.cards : [];
    assert.equal(cardsNoProfile.some((c) => c && c.type === 'recommendations'), false);
    assert.ok(cardsNoProfile.some((c) => c && c.type === 'diagnosis_gate'));
    assert.equal(cardsNoProfile.some((c) => c && c.type === 'routine_simulation'), false);
    assert.equal(cardsNoProfile.some((c) => c && c.type === 'conflict_heatmap'), false);
    assert.ok(Array.isArray(respNoProfile.body?.suggested_chips));
    assert.ok(
      respNoProfile.body.suggested_chips.some((c) => {
        const id = String(c?.chip_id || '');
        return id.startsWith('profile.skinType.') || id.startsWith('profile.sensitivity.');
      }),
    );
    assert.equal(JSON.stringify(respNoProfile.body).includes('kb:'), false);
    // No value_moment product reco should be emitted when gated.
    assert.equal((respNoProfile.body?.events || []).some((e) => e && e.event_name === 'recos_requested'), true);

    // Seed a minimally-complete profile so reco routing is allowed.
    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_cn_reco', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening', 'pores'],
        budgetTier: '¥500',
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_cn_reco', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        message: '要烟酰胺精华，最好温和点',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(typeof resp.body?.assistant_message?.content, 'string');

    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const hasReco = cards.some((c) => c && c.type === 'recommendations');
    const conf = cards.find((c) => c && c.type === 'confidence_notice') || null;
    assert.ok(hasReco || conf);
    if (conf) {
      assert.equal(conf?.payload?.reason, 'artifact_missing');
    }
    assert.equal(cards.some((c) => c && c.type === 'routine_simulation'), false);
    assert.equal(cards.some((c) => c && c.type === 'conflict_heatmap'), false);

    // Non-debug responses must not leak internal kb:* refs anywhere.
    assert.equal(JSON.stringify(resp.body).includes('kb:'), false);

    const events = Array.isArray(resp.body?.events) ? resp.body.events : [];
    const recosRequested = events.find((e) => e && e.event_name === 'recos_requested') || null;
    assert.ok(recosRequested);
    const vm = events.find((e) => e && e.event_name === 'value_moment') || null;
    if (hasReco) {
      assert.ok(vm);
      assert.equal(vm?.data?.kind, 'product_reco');
    } else {
      assert.equal(vm, null);
      assert.equal(recosRequested?.data?.reason, 'artifact_missing');
    }
    },
  );
});

test('/v1/chat: collapses overlong templated answers when cards are present', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_overlong_template', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        budgetTier: '¥500',
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

	    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
	      headers: { 'X-Aurora-UID': 'test_uid_overlong_template', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
	      body: {
	        // Ensure we go through the upstream structured path (not deterministic recommendation routing).
	        message: 'OVERLONG_TEMPLATE_CONTEXT_TEST',
	        session: { state: 'idle' },
	        language: 'CN',
	      },
	    });

    assert.equal(resp.status, 200);
    const assistant = String(resp.body?.assistant_message?.content || '').trim();
    assert.ok(assistant);
    // Keep assistant_message concise when structured cards are present (avoid long templated essays).
    assert.ok(assistant.length < 120);
    assert.equal(/\bpart\s*\d+\s*:/i.test(assistant), false);

	    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
	    assert.ok(cards.some((c) => c && c.type === 'aurora_structured'));
	    assert.equal(JSON.stringify(resp.body).includes('kb:'), false);
	  });
	});

test('/v1/chat: overlong template without renderable cards does NOT claim "cards below"', async () => {
  await withEnv({ AURORA_BFF_CONFLICT_HEATMAP_V1_ENABLED: 'true', AURORA_BFF_RETENTION_DAYS: '0' }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const seed = await invokeRoute(app, 'POST', '/v1/profile/update', {
      headers: { 'X-Aurora-UID': 'test_uid_stub_only', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'healthy',
        goals: ['brightening'],
        budgetTier: '¥500',
        region: 'CN',
      },
    });
    assert.equal(seed.status, 200);

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_stub_only', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
      body: {
        // Mock upstream returns an overlong templated essay + structured stub, but no citations/cards.
        message: 'STRUCTURED_STUB_ONLY_TEST',
        session: { state: 'idle' },
        language: 'CN',
      },
    });

    assert.equal(resp.status, 200);
    const assistant = String(resp.body?.assistant_message?.content || '').trim();
    assert.ok(assistant);
    // Must not claim "see cards below" when UI is expected to hide structured stub (no citations).
    assert.equal(assistant.includes('见下方'), false);
    assert.equal(/\bcards\s+below\b/i.test(assistant), false);
  });
});

test('/v1/chat: short "cards below" stub does not claim hidden cards', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_short_cards_stub', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        // Mock upstream returns a short "cards below" sentence + structured stub, but no citations/cards.
        message: 'SHORT_CARDS_BELOW_STUB_TEST',
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const assistant = String(resp.body?.assistant_message?.content || '').trim();
    assert.ok(assistant);
    assert.equal(/\bcards\s+below\b/i.test(assistant), false);
    assert.equal(assistant.includes('见下方'), false);
  });
});

test('/v1/chat: cards-below stub + stripped recos does not claim hidden cards', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_cards_stub_stripped_reco', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        // Mock upstream returns "cards below" + structured stub + reco-like card. BFF strips recos unless explicit,
        // leaving only hidden cards (structured has no citations, and gate_notice is hidden in non-debug UI).
        message: 'SHORT_CARDS_BELOW_STRIPPED_RECO_TEST',
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const assistant = String(resp.body?.assistant_message?.content || '').trim();
    assert.ok(assistant);
    assert.equal(/\bcards\s+below\b/i.test(assistant), false);
    assert.equal(assistant.includes('见下方'), false);

    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('recommendations'), false);
    assert.ok(cardTypes.includes('gate_notice'));
  });
});

test('/v1/chat: reco chip gates when profile is incomplete', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_reco_gate_chip_1', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        action: { action_id: 'chip.start.reco_products', kind: 'chip', data: { reply_text: 'Recommend a few products' } },
        session: { state: 'S7_PRODUCT_RECO' },
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(resp.body?.session_patch?.next_state, 'RECO_GATE');
    assert.equal(resp.body?.session_patch?.state?._internal_next_state, 'S2_DIAGNOSIS');

    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    assert.ok(cards.some((c) => c && c.type === 'diagnosis_gate'));
    assert.equal(cards.some((c) => c && c.type === 'recommendations'), false);
  });
});

test('/v1/chat: profile.patch does not auto-advance to photo', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
      const m = String(method || '').toLowerCase();
      const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
      const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
      if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

      const req = {
        method: String(method || '').toUpperCase(),
        path: routePath,
        body,
        query,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        get(name) {
          return this.headers[String(name || '').toLowerCase()] || '';
        },
      };

      const res = {
        statusCode: 200,
        headers: {},
        body: undefined,
        headersSent: false,
        status(code) {
          this.statusCode = code;
          return this;
        },
        setHeader(name, value) {
          this.headers[String(name || '').toLowerCase()] = value;
        },
        header(name, value) {
          this.setHeader(name, value);
          return this;
        },
        json(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
        send(payload) {
          this.body = payload;
          this.headersSent = true;
          return this;
        },
      };

      const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
      for (const fn of handlers) {
        // eslint-disable-next-line no-await-in-loop
        await fn(req, res, () => {});
        if (res.headersSent) break;
      }

      return { status: res.statusCode, body: res.body };
    };

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid_profile_patch_no_photo', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        action: {
          action_id: 'profile.patch',
          kind: 'action',
          data: {
            profile_patch: {
              skinType: 'oily',
              barrierStatus: 'impaired',
              sensitivity: 'low',
              goals: ['acne'],
            },
          },
        },
        session: { state: 'S2_DIAGNOSIS' },
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(typeof resp.body?.session_patch, 'object');
    assert.equal(Object.prototype.hasOwnProperty.call(resp.body.session_patch, 'profile'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(resp.body.session_patch, 'next_state'), true);
    assert.equal(resp.body?.session_patch?.next_state, 'IDLE_CHAT');
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    assert.ok(cards.some((c) => c && c.type === 'profile'));
  });
});

test('/v1/chat: exposes env_stress + citations + conflicts cards (contracts)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Debug': 'true' },
    body: {
      message: 'CONTEXT_CARDS_TEST',
      anchor_product_id: 'mock_anchor_1',
      session: { state: 'idle' },
      language: 'EN',
      debug: true,
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));

  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];

  const structured = cards.find((c) => c && c.type === 'aurora_structured');
  assert.ok(structured);
  const citations = structured?.payload?.external_verification?.citations;
  assert.ok(Array.isArray(citations));
  assert.ok(citations.length > 0);

  const envStress = cards.find((c) => c && c.type === 'env_stress');
  assert.ok(envStress);
  assert.equal(envStress?.payload?.schema_version, 'aurora.ui.env_stress.v1');
  assert.equal(envStress?.payload?.ess, 88);
  const radar = envStress?.payload?.radar;
  assert.ok(Array.isArray(radar));
  assert.ok(radar.length > 0);
  assert.ok(radar.every((r) => typeof r?.value === 'number' && r.value >= 0 && r.value <= 100));

  const sim = cards.find((c) => c && c.type === 'routine_simulation');
  assert.ok(sim);
  assert.equal(sim?.payload?.schema_version, 'aurora.conflicts.v1');
  assert.equal(sim?.payload?.safe, false);
  assert.ok(Array.isArray(sim?.payload?.conflicts));
  assert.ok(sim.payload.conflicts.some((c) => c && c.rule_id === 'retinoid_x_acids'));

  const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
  assert.ok(heatmap);
  assert.equal(heatmap?.payload?.schema_version, 'aurora.ui.conflict_heatmap.v1');
});

test('/v1/chat: weather question short-circuits to env_stress (trigger_source=text)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_env_1', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
    body: {
      message: '明天要下雪，我应该注意什么？',
      // Simulate being mid-flow: should still short-circuit instead of calling upstream/diagnosis routing.
      client_state: 'DIAG_PROFILE',
      session: { state: 'S7_PRODUCT_RECO' },
      language: 'CN',
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  assert.ok(Array.isArray(resp.body?.suggested_chips));

  const envStress = resp.body.cards.find((c) => c && c.type === 'env_stress');
  assert.ok(envStress);
  assert.equal(envStress?.payload?.schema_version, 'aurora.ui.env_stress.v1');

  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /对应产品清单/);
  assert.match(resp.body.assistant_message.content, /防晒/);
  assert.match(resp.body.assistant_message.content, /润唇/);

  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.routine'));
  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.reco_products'));

  const vm = (resp.body?.events || []).find((e) => e && e.event_name === 'value_moment') || null;
  assert.ok(vm);
  assert.equal(vm?.data?.kind, 'weather_advice');
  assert.equal(vm?.data?.scenario, 'snow');
});

test('/v1/chat: weather question short-circuits to env_stress (trigger_source=text_explicit)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/chat', {
    headers: { 'X-Aurora-UID': 'test_uid_env_2', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'CN' },
    body: {
      // Contains "推荐" -> trigger_source=text_explicit. Should still go to env-stress, not upstream.
      message: '下雪天推荐我怎么护肤？',
      session: { state: 'S7_PRODUCT_RECO' },
      language: 'CN',
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  assert.ok(Array.isArray(resp.body?.suggested_chips));

  const envStress = resp.body.cards.find((c) => c && c.type === 'env_stress');
  assert.ok(envStress);
  assert.equal(envStress?.payload?.schema_version, 'aurora.ui.env_stress.v1');

  assert.equal(typeof resp.body?.assistant_message?.content, 'string');
  assert.match(resp.body.assistant_message.content, /对应产品清单/);
  assert.match(resp.body.assistant_message.content, /防晒/);
  assert.match(resp.body.assistant_message.content, /润唇/);

  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.routine'));
  assert.ok(resp.body.suggested_chips.some((c) => c && c.chip_id === 'chip.start.reco_products'));

  const vm = (resp.body?.events || []).find((e) => e && e.event_name === 'value_moment') || null;
  assert.ok(vm);
  assert.equal(vm?.data?.kind, 'weather_advice');
  assert.equal(vm?.data?.scenario, 'snow');
});

test('/v1/analysis/skin: allow no-photo analysis (continue without photos)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: { use_photo: false, photos: [] },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  const card = resp.body.cards.find((c) => c && c.type === 'analysis_summary');
  assert.ok(card);
  assert.equal(card.payload?.analysis_source, 'baseline_low_confidence');
  const missing = Array.isArray(card.field_missing) ? card.field_missing : [];
  assert.equal(missing.some((m) => String(m?.field || '') === 'profile.currentRoutine'), false);
});

test('/v1/analysis/skin: accepts routine input and avoids low-confidence baseline', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
    body: {
      use_photo: false,
      currentRoutine: {
        am: { cleanser: 'CeraVe Foaming Cleanser', spf: 'EltaMD UV Clear' },
        pm: { cleanser: 'CeraVe Foaming Cleanser', treatment: 'Retinol 0.2%', moisturizer: 'CeraVe PM' },
        notes: 'Sometimes stings after retinol.',
      },
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  const card = resp.body.cards.find((c) => c && c.type === 'analysis_summary');
  assert.ok(card);
  assert.notEqual(card.payload?.analysis_source, 'baseline_low_confidence');

  const missing = Array.isArray(card.field_missing) ? card.field_missing : [];
  assert.equal(missing.some((m) => String(m?.field || '') === 'profile.currentRoutine'), false);

  const analysis = card.payload?.analysis;
  assert.equal(Boolean(analysis && typeof analysis === 'object'), true);
  assert.equal(Array.isArray(analysis.features), true);
  assert.ok(analysis.features.length > 0);
});

test('/v1/product/analyze: returns verdict + enriched reasons', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/product/analyze', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: { name: 'Mock Parsed Product' },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'product_analysis');
  assert.ok(card);

  assert.equal(card.payload?.assessment?.verdict, 'Suitable');
  const reasons = card.payload?.assessment?.reasons;
  assert.equal(Array.isArray(reasons), true);
  assert.ok(reasons.length >= 2);
  assert.ok(reasons.some((r) => /most impactful ingredient/i.test(String(r || ''))));
});

test('/v1/dupe/compare: returns tradeoffs (prefers structured alternatives)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/dupe/compare', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: {
      original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
      dupe: { brand: 'MockDupeBrand', name: 'mock_dupe' },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'dupe_compare');
  assert.ok(card);

  const payload = card.payload || {};
  assert.ok(payload.original);
  assert.ok(payload.dupe);

  const tradeoffs = Array.isArray(payload.tradeoffs) ? payload.tradeoffs : [];
  assert.ok(tradeoffs.length > 0);
  assert.ok(tradeoffs.some((t) => /missing actives|added benefits|texture/i.test(String(t || ''))));
});

test('/v1/dupe/compare: falls back to deepscan diff when compare is empty', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/dupe/compare', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: {
      original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
      dupe: { brand: 'MockDupeBrand', name: 'mock_dupe' },
      original_url: 'https://example.com/COMPARE_EMPTY_TEST',
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'dupe_compare');
  assert.ok(card);

  const tradeoffs = Array.isArray(card.payload?.tradeoffs) ? card.payload.tradeoffs : [];
  assert.ok(tradeoffs.length > 0);
  assert.ok(
    tradeoffs.some((t) =>
      /compared to original|dupe adds|texture|irritation risk|fragrance risk|dupe risk notes|hero ingredient shift|key ingredient emphasis|no tradeoff details were returned/i.test(
        String(t || ''),
      ),
    ),
  );
});

test('/v1/dupe/compare: dupe not in alternatives uses human tradeoffs (no raw diff)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/dupe/compare', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: {
      original: { brand: 'MockBrand', name: 'Mock Parsed Product' },
      dupe: { brand: 'OtherBrand', name: 'Some Other Product' },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'dupe_compare');
  assert.ok(card);

  const tradeoffs = Array.isArray(card.payload?.tradeoffs) ? card.payload.tradeoffs : [];
  assert.ok(tradeoffs.length > 0);
  assert.ok(tradeoffs.every((t) => !/missing actives vs original|added actives/i.test(String(t || ''))));
});

test('/v1/analysis/skin: qc fail returns retake analysis (no guesses)', async () => {
  const express = require('express');
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
    const m = String(method || '').toLowerCase();
    const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
    const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
    if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

    const req = {
      method: String(method || '').toUpperCase(),
      path: routePath,
      body,
      query,
      headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      get(name) {
        return this.headers[String(name || '').toLowerCase()] || '';
      },
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      headersSent: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[String(name || '').toLowerCase()] = value;
      },
      header(name, value) {
        this.setHeader(name, value);
        return this;
      },
      json(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
      send(payload) {
        this.body = payload;
        this.headersSent = true;
        return this;
      },
    };

    const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
    for (const fn of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await fn(req, res, () => {});
      if (res.headersSent) break;
    }

    return { status: res.statusCode, body: res.body };
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
    headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
    body: {
      use_photo: true,
      currentRoutine: 'AM: gentle cleanser + SPF. PM: gentle cleanser + adapalene + moisturizer.',
      photos: [{ slot_id: 'daylight', photo_id: 'photo_1', qc_status: 'fail' }],
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(resp.body);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((c) => c && c.type === 'analysis_summary');
  assert.ok(card);

  assert.equal(card.payload.analysis_source, 'retake');
  assert.equal(card.payload?.quality_report?.photo_quality?.grade, 'fail');
  assert.equal(card.payload?.quality_report?.llm?.vision?.decision, 'skip');
  assert.equal(card.payload?.quality_report?.llm?.report?.decision, 'skip');
  assert.equal(Array.isArray(card.payload?.analysis?.features), true);
  assert.match(String(card.payload.analysis.features[0].observation || ''), /photo/i);
});

test('/v1/analysis/skin: upload->fetch->diagnosis path uses photo bytes (used_photos=true)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const sharp = require('sharp');

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 216, g: 180, b: 160 } },
      })
        .png()
        .toBuffer();

      axios.post = async (url) => {
        if (String(url).endsWith('/photos/presign')) {
          return {
            status: 200,
            data: {
              upload_id: 'upload_64x64',
              upload: { method: 'PUT', url: 'https://signed-upload.test/object', headers: {} },
            },
          };
        }
        if (String(url).endsWith('/photos/confirm')) {
          return {
            status: 200,
            data: {
              qc_status: 'passed',
              qc: { state: 'done', qc_status: 'passed', advice: { summary: 'ok', suggestions: [] } },
            },
          };
        }
        throw new Error(`Unexpected axios.post url: ${url}`);
      };
      axios.request = async (config) => {
        if (String(config?.url || '') === 'https://signed-upload.test/object') {
          if (config?.data && typeof config.data.on === 'function') {
            await new Promise((resolve, reject) => {
              config.data.on('data', () => {});
              config.data.on('end', resolve);
              config.data.on('error', reject);
            });
          }
          return { status: 200, data: '' };
        }
        throw new Error(`Unexpected axios.request url: ${config?.url || ''}`);
      };
      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/object',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/object') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        if (u.endsWith('/photos/qc')) {
          return {
            status: 200,
            data: { qc_status: 'passed', qc: { state: 'done', qc_status: 'passed' } },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      try {
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);
        const headers = {
          'X-Aurora-UID': 'uid_photo_path',
          'X-Trace-ID': 'trace_photo_path',
          'X-Brief-ID': 'brief_photo_path',
          'X-Lang': 'EN',
        };

        const uploadResp = await request
          .post('/v1/photos/upload')
          .set(headers)
          .field('slot_id', 'daylight')
          .field('consent', 'true')
          .attach('photo', pngBytes, { filename: 'face.png', contentType: 'image/png' })
          .expect(200);

        const uploadCard = Array.isArray(uploadResp.body?.cards)
          ? uploadResp.body.cards.find((c) => c && c.type === 'photo_confirm')
          : null;
        assert.ok(uploadCard);
        const photoId = uploadCard?.payload?.photo_id;
        assert.equal(typeof photoId, 'string');
        assert.ok(photoId.length > 0);
        const uploadAnalysisCard = Array.isArray(uploadResp.body?.cards)
          ? uploadResp.body.cards.find((c) => c && c.type === 'analysis_summary')
          : null;
        assert.ok(uploadAnalysisCard);
        assert.equal(uploadAnalysisCard?.payload?.used_photos, true);

        const analysisResp = await request
          .post('/v1/analysis/skin')
          .set(headers)
          .send({
            use_photo: true,
            currentRoutine: 'AM gentle cleanser + SPF; PM gentle cleanser + retinol + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: photoId, qc_status: 'passed' }],
          })
          .expect(200);

        const analysisCard = Array.isArray(analysisResp.body?.cards)
          ? analysisResp.body.cards.find((c) => c && c.type === 'analysis_summary')
          : null;
        assert.ok(analysisCard);
        assert.equal(analysisCard?.payload?.used_photos, true);
        assert.notEqual(analysisCard?.payload?.analysis_source, 'rule_based_with_photo_qc');
        assert.equal(Boolean(analysisCard?.payload?.photo_notice), false);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: photo fetch 4xx exposes photo_notice + failure_code', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      axios.post = originalPost;
      axios.request = originalRequest;

      try {
        axios.get = async (url) => {
          const u = String(url || '');
          if (u.endsWith('/photos/download-url')) {
            return {
              status: 200,
              data: {
                download: {
                  url: 'https://signed-download.test/fail-403',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (u === 'https://signed-download.test/fail-403') {
            return { status: 403, data: 'access denied' };
          }
          throw new Error(`Unexpected axios.get url: ${u}`);
        };

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_fail_4xx',
            'X-Trace-ID': 'trace_4xx',
            'X-Brief-ID': 'brief_4xx',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'PM retinol + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_4xx', qc_status: 'passed' }],
          })
          .expect(200);

        const card = Array.isArray(resp.body?.cards) ? resp.body.cards.find((c) => c && c.type === 'analysis_summary') : null;
        assert.ok(card);
        assert.equal(card?.payload?.used_photos, false);
        assert.equal(card?.payload?.analysis_source, 'rule_based_with_photo_qc');
        assert.equal(card?.payload?.photo_notice?.failure_code, 'DOWNLOAD_URL_FETCH_4XX');
        assert.match(String(card?.payload?.photo_notice?.message || ''), /couldn't analyze your photo/i);
        const actionCard = card?.payload?.analysis?.next_action_card;
        assert.ok(actionCard && typeof actionCard === 'object');
        assert.equal(Array.isArray(actionCard.retake_guide), true);
        assert.equal(actionCard.retake_guide.length, 3);
        assert.equal(Array.isArray(actionCard.ask_3_questions), true);
        assert.equal(actionCard.ask_3_questions.length, 3);
        const serializedAnalysis = JSON.stringify(card?.payload?.analysis || {}).toLowerCase();
        assert.equal(/acne|pigmentation/.test(serializedAnalysis), false);
        const missing = Array.isArray(card?.field_missing) ? card.field_missing : [];
        assert.equal(missing.some((f) => f && f.field === 'analysis.used_photos' && f.reason === 'DOWNLOAD_URL_FETCH_4XX'), true);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/photos/upload: auto analysis failure still returns photo_confirm', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM: 'true',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const metricsModuleId = require.resolve('../src/auroraBff/visionMetrics');
      delete require.cache[routesModuleId];
      delete require.cache[metricsModuleId];
      const visionMetrics = require('../src/auroraBff/visionMetrics');
      const originalRecordAnalyzeRequest = visionMetrics.recordAnalyzeRequest;
      visionMetrics.recordAnalyzeRequest = () => {
        throw new Error('synthetic_auto_analysis_failure');
      };
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
          'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
          'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
          '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
        'base64',
      );

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;

      axios.post = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/presign')) {
          return {
            status: 200,
            data: {
              upload_id: 'photo_upload_auto_fail',
              upload: {
                url: 'https://signed-upload.test/object',
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
              },
            },
          };
        }
        if (u.endsWith('/photos/confirm')) {
          return {
            status: 200,
            data: {
              upload_id: 'photo_upload_auto_fail',
              qc_status: 'passed',
              qc: { state: 'done', qc_status: 'passed' },
            },
          };
        }
        throw new Error(`Unexpected axios.post url: ${u}`);
      };

      axios.get = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/qc')) {
          return {
            status: 200,
            data: { qc_status: 'passed', qc: { state: 'done', qc_status: 'passed' } },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      axios.request = async (config = {}) => {
        if (String(config.url || '') === 'https://signed-upload.test/object') {
          return { status: 200, data: '' };
        }
        throw new Error(`Unexpected axios.request url: ${String(config.url || '')}`);
      };

      try {
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);

        const uploadResp = await request
          .post('/v1/photos/upload')
          .set({
            'X-Aurora-UID': 'uid_photo_upload_auto_fail',
            'X-Trace-ID': 'trace_photo_upload_auto_fail',
            'X-Brief-ID': 'brief_photo_upload_auto_fail',
            'X-Lang': 'EN',
          })
          .field('slot_id', 'daylight')
          .field('consent', 'true')
          .attach('photo', pngBytes, { filename: 'face.png', contentType: 'image/png' })
          .expect(200);

        const cards = Array.isArray(uploadResp.body?.cards) ? uploadResp.body.cards : [];
        const events = Array.isArray(uploadResp.body?.events) ? uploadResp.body.events : [];
        const confirmCard = cards.find((c) => c && c.type === 'photo_confirm');
        const analysisCard = cards.find((c) => c && c.type === 'analysis_summary');
        const autoFailEvent = events.find((e) => e && e.event_name === 'error' && e.data && e.data.code === 'PHOTO_AUTO_ANALYSIS_FAILED');

        assert.ok(confirmCard);
        assert.equal(Boolean(analysisCard), false);
        assert.ok(autoFailEvent);
      } finally {
        visionMetrics.recordAnalyzeRequest = originalRecordAnalyzeRequest;
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[routesModuleId];
        delete require.cache[metricsModuleId];
      }
    },
  );
});

test('/v1/photos/confirm: qc passed auto-triggers analysis_summary', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM: 'true',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
          'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
          'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
          '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
        'base64',
      );

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;

      axios.post = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/confirm')) {
          return {
            status: 200,
            data: {
              upload_id: 'photo_confirm_auto',
              qc_status: 'passed',
              qc: { state: 'done', qc_status: 'passed' },
            },
          };
        }
        throw new Error(`Unexpected axios.post url: ${u}`);
      };

      axios.get = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/confirm-object',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/confirm-object') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        if (u.endsWith('/photos/qc')) {
          return {
            status: 200,
            data: { qc_status: 'passed', qc: { state: 'done', qc_status: 'passed' } },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      axios.request = originalRequest;

      try {
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);

        const resp = await request
          .post('/v1/photos/confirm')
          .set({
            'X-Aurora-UID': 'uid_photo_confirm_auto',
            'X-Trace-ID': 'trace_photo_confirm_auto',
            'X-Brief-ID': 'brief_photo_confirm_auto',
            'X-Lang': 'EN',
          })
          .send({ photo_id: 'photo_confirm_auto', slot_id: 'daylight' })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const confirmCard = cards.find((c) => c && c.type === 'photo_confirm');
        const analysisCard = cards.find((c) => c && c.type === 'analysis_summary');
        assert.ok(confirmCard);
        assert.ok(analysisCard);
        assert.equal(typeof analysisCard?.payload?.used_photos, 'boolean');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/photos/confirm: nested qc status triggers auto analysis when top-level qc_status is missing', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM: 'true',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
          'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
          'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
          '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
        'base64',
      );

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;

      axios.post = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/confirm')) {
          return {
            status: 200,
            data: {
              upload_id: 'photo_confirm_nested_qc',
              qc: { state: 'done', status: 'passed' },
            },
          };
        }
        throw new Error(`Unexpected axios.post url: ${u}`);
      };

      axios.get = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/confirm-nested-qc',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/confirm-nested-qc') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        if (u.endsWith('/photos/qc')) {
          return {
            status: 200,
            data: { qc: { state: 'done', status: 'passed' } },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      axios.request = originalRequest;

      try {
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);

        const resp = await request
          .post('/v1/photos/confirm')
          .set({
            'X-Aurora-UID': 'uid_photo_confirm_nested_qc',
            'X-Trace-ID': 'trace_photo_confirm_nested_qc',
            'X-Brief-ID': 'brief_photo_confirm_nested_qc',
            'X-Lang': 'EN',
          })
          .send({ photo_id: 'photo_confirm_nested_qc', slot_id: 'daylight' })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const confirmCard = cards.find((c) => c && c.type === 'photo_confirm');
        const analysisCard = cards.find((c) => c && c.type === 'analysis_summary');
        assert.ok(confirmCard);
        assert.equal(confirmCard?.payload?.qc_status, 'passed');
        assert.ok(analysisCard);
        assert.equal(typeof analysisCard?.payload?.used_photos, 'boolean');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/photos/confirm: auto analysis quality-fail uses retake source without routine-missing flag', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM: 'true',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[routesModuleId];
      delete require.cache[skinModuleId];

      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      skinDiagnosis.runSkinDiagnosisV1 = async () => ({
        ok: true,
        diagnosis: {
          quality: { grade: 'fail', reasons: ['blur'] },
          findings: [],
        },
      });

      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
          'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
          'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
          '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
        'base64',
      );

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;

      axios.post = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/confirm')) {
          return {
            status: 200,
            data: {
              upload_id: 'photo_confirm_quality_fail',
              qc_status: 'passed',
              qc: { state: 'done', qc_status: 'passed' },
            },
          };
        }
        throw new Error(`Unexpected axios.post url: ${u}`);
      };

      axios.get = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/confirm-quality-fail',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/confirm-quality-fail') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        if (u.endsWith('/photos/qc')) {
          return {
            status: 200,
            data: { qc_status: 'passed', qc: { state: 'done', qc_status: 'passed' } },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      axios.request = originalRequest;

      try {
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);

        const resp = await request
          .post('/v1/photos/confirm')
          .set({
            'X-Aurora-UID': 'uid_photo_confirm_quality_fail',
            'X-Trace-ID': 'trace_photo_confirm_quality_fail',
            'X-Brief-ID': 'brief_photo_confirm_quality_fail',
            'X-Lang': 'EN',
          })
          .send({ photo_id: 'photo_confirm_quality_fail', slot_id: 'daylight' })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const analysisCard = cards.find((c) => c && c.type === 'analysis_summary');
        assert.ok(analysisCard);
        assert.equal(analysisCard?.payload?.analysis_source, 'retake');
        const missing = Array.isArray(analysisCard?.field_missing) ? analysisCard.field_missing : [];
        assert.equal(
          missing.some((item) => item && item.field === 'analysis.used_photos' && item.reason === 'routine_or_recent_logs_required'),
          false,
        );
      } finally {
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[routesModuleId];
        delete require.cache[skinModuleId];
      }
    },
  );
});

test('/v1/analysis/skin: photos without use_photo still default to photo analysis', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const sharp = require('sharp');
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 216, g: 180, b: 160 } },
      })
        .png()
        .toBuffer();

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      axios.post = originalPost;
      axios.request = originalRequest;

      try {
        axios.get = async (url) => {
          const u = String(url || '');
          if (u.endsWith('/photos/download-url')) {
            return {
              status: 200,
              data: {
                download: {
                  url: 'https://signed-download.test/default-use-photo',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (u === 'https://signed-download.test/default-use-photo') {
            return {
              status: 200,
              data: pngBytes,
              headers: { 'content-type': 'image/png' },
            };
          }
          throw new Error(`Unexpected axios.get url: ${u}`);
        };

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_use_default',
            'X-Trace-ID': 'trace_photo_use_default',
            'X-Brief-ID': 'brief_photo_use_default',
            'X-Lang': 'EN',
          })
          .send({
            currentRoutine: 'AM cleanser + SPF; PM cleanser + retinol + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_default_use_photo', qc_status: 'passed' }],
          })
          .expect(200);

        const card = Array.isArray(resp.body?.cards) ? resp.body.cards.find((c) => c && c.type === 'analysis_summary') : null;
        assert.ok(card);
        assert.equal(card?.payload?.used_photos, true);
        const visionReasons = Array.isArray(card?.payload?.quality_report?.llm?.vision?.reasons)
          ? card.payload.quality_report.llm.vision.reasons
          : [];
        assert.equal(visionReasons.includes('photo_not_requested'), false);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: photo fetch timeout exposes DOWNLOAD_URL_TIMEOUT notice', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      axios.post = originalPost;
      axios.request = originalRequest;

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/fail-timeout',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/fail-timeout') {
          const err = new Error('timeout of 800ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_fail_timeout',
            'X-Trace-ID': 'trace_timeout',
            'X-Brief-ID': 'brief_timeout',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'PM retinol + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_timeout', qc_status: 'passed' }],
          })
          .expect(200);

        const card = Array.isArray(resp.body?.cards) ? resp.body.cards.find((c) => c && c.type === 'analysis_summary') : null;
        assert.ok(card);
        assert.equal(card?.payload?.used_photos, false);
        assert.equal(card?.payload?.analysis_source, 'rule_based_with_photo_qc');
        assert.equal(card?.payload?.photo_notice?.failure_code, 'DOWNLOAD_URL_TIMEOUT');
        const missing = Array.isArray(card?.field_missing) ? card.field_missing : [];
        assert.equal(missing.some((f) => f && f.field === 'analysis.used_photos' && f.reason === 'DOWNLOAD_URL_TIMEOUT'), true);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchPhotoBytesFromPivotaBackend: signed URL expired maps to DOWNLOAD_URL_EXPIRED', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_PHOTO_FETCH_RETRIES: '0',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { __internal } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const originalGet = axios.get;

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/expired',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
            },
          };
        }
        if (u === 'https://signed-download.test/expired') {
          return { status: 403, data: 'Request has expired' };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      try {
        const req = {
          get(name) {
            const key = String(name || '').toLowerCase();
            if (key === 'x-aurora-uid') return 'uid_expired_case';
            return '';
          },
        };
        const out = await __internal.fetchPhotoBytesFromPivotaBackend({ req, photoId: 'photo_expired_case' });
        assert.equal(out?.ok, false);
        assert.equal(out?.failure_code, 'DOWNLOAD_URL_EXPIRED');
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

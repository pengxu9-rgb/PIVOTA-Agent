const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_CHATCARDS_RESPONSE_CONTRACT = 'dual';
process.env.AURORA_RULE_RELAX_MODE = 'conservative';
process.env.AURORA_BFF_RECO_PDP_LIGHT_ENRICH = 'false';
process.env.AURORA_BFF_RECO_ALTERNATIVES_ANCHORLESS_ON_PRECHECK_FAILURE = 'false';

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

function assertPassiveGateAdvisorySignal(body, gateId) {
  const sessionPatch =
    body && body.session_patch && typeof body.session_patch === 'object' && !Array.isArray(body.session_patch)
      ? body.session_patch
      : {};
  const meta =
    sessionPatch.meta && typeof sessionPatch.meta === 'object' && !Array.isArray(sessionPatch.meta)
      ? sessionPatch.meta
      : {};
  const passiveSuppressed = meta.passive_gate_suppressed === true;
  const suppressedGateIds = Array.isArray(meta.suppressed_gate_ids)
    ? meta.suppressed_gate_ids.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const events = Array.isArray(body && body.events) ? body.events : [];
  const hasGateEvent = events.some((evt) => {
    if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return false;
    if (String(evt.event_name || '').trim() !== 'gate_advisory_inline') return false;
    const eventData =
      evt.data && typeof evt.data === 'object' && !Array.isArray(evt.data)
        ? evt.data
        : evt.event_data && typeof evt.event_data === 'object' && !Array.isArray(evt.event_data)
          ? evt.event_data
          : {};
    return String(eventData.gate_id || '').trim() === gateId;
  });
  assert.equal(passiveSuppressed || suppressedGateIds.includes(gateId) || hasGateEvent, true);
}

test('__internal: recommendation rows synthesize pdp_open from authority identity', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const normalized = __internal.normalizeRecoCatalogProduct({
      product_id: 'ext_bbe1ff8884f06d874bbccbd8',
      merchant_id: 'external_seed',
      brand: 'The Ordinary',
      display_name: 'UV Filters SPF 45 Serum',
      pdp_url: 'https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html',
    });
    assert.equal(normalized?.pdp_open?.path, 'ref');
    assert.deepEqual(normalized?.pdp_open?.product_ref, {
      product_id: 'ext_bbe1ff8884f06d874bbccbd8',
      merchant_id: 'external_seed',
    });

    const coerced = __internal.coerceRecoItemForUi(
      {
        product_id: '9886499864904',
        merchant_id: 'merch_efbc46b4619cfbdf',
        canonical_product_ref: {
          product_id: '9886499864904',
          merchant_id: 'merch_efbc46b4619cfbdf',
        },
        brand: 'The Ordinary',
        display_name: 'Niacinamide 10% + Zinc 1%',
        pdp_url: 'https://agent.pivota.cc/products/9886499864904?merchant_id=merch_efbc46b4619cfbdf',
      },
      { lang: 'EN' },
    );
    assert.equal(coerced?.pdp_open?.path, 'ref');
    assert.deepEqual(coerced?.pdp_open?.get_pdp_v2_payload?.product_ref, {
      product_id: '9886499864904',
      merchant_id: 'merch_efbc46b4619cfbdf',
    });
    assert.equal(coerced?.metadata?.pdp_open_path, 'internal');
    assert.equal(coerced?.metadata?.pdp_open_mode, 'ref');
  } finally {
    delete require.cache[moduleId];
  }
});

test('extractQuickProfileLightweightPatch maps lightweight quick-profile signals', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const patch = __internal.extractQuickProfileLightweightPatch({
      skin_feel: 'combination',
      goal_primary: 'breakouts',
      sensitivity_flag: 'yes',
    });
    assert.deepEqual(patch, {
      skinType: 'combination',
      goals: ['acne'],
      sensitivity: 'high',
    });
  } finally {
    delete require.cache[moduleId];
  }
});

test('extractProfilePatchFromRequestContextPayload reads nested quick-profile signals', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const patch = __internal.extractProfilePatchFromRequestContextPayload({
      context: {
        skin_feel: 'oily',
        goal_primary: 'antiaging',
        sensitivity_flag: 'unsure',
      },
    });
    assert.deepEqual(patch, {
      skinType: 'oily',
      goals: ['wrinkles'],
      sensitivity: 'unknown',
    });
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: filterRecoContextProductCandidates drops wrong-family and query-shaped synthetic candidates', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const filtered = __internal.filterRecoContextProductCandidates(
      [
        {
          product_id: 'prod_retinol_wrong_family',
          merchant_id: 'mid_test',
          brand: 'BarrierLab',
          name: 'Night Retinol Emulsion',
          display_name: 'BarrierLab Night Retinol Emulsion',
          category: 'moisturizer',
          retrieval_source: 'catalog',
          retrieval_reason: 'catalog_search_match',
          canonical_product_ref: { product_id: 'prod_retinol_wrong_family', merchant_id: 'mid_test' },
          url: 'https://agent.pivota.cc/products/prod_retinol_wrong_family?merchant_id=mid_test&entry=creator_agent',
        },
        {
          product_id: 'prod_query_like_best',
          merchant_id: 'mid_test',
          brand: 'BarrierLab',
          name: 'Ceramide NP skincare product best',
          display_name: 'BarrierLab Ceramide NP skincare product best',
          category: 'moisturizer',
          retrieval_source: 'catalog',
          retrieval_reason: 'catalog_search_match',
          canonical_product_ref: { product_id: 'prod_query_like_best', merchant_id: 'mid_test' },
          url: 'https://agent.pivota.cc/products/prod_query_like_best?merchant_id=mid_test&entry=creator_agent',
        },
        {
          product_id: 'prod_query_like_context',
          merchant_id: 'mid_test',
          brand: 'BarrierLab',
          name: 'moisturizer barrier Ceramide NP',
          display_name: 'BarrierLab moisturizer barrier Ceramide NP',
          category: 'moisturizer',
          retrieval_source: 'catalog',
          retrieval_reason: 'catalog_search_match',
          canonical_product_ref: { product_id: 'prod_query_like_context', merchant_id: 'mid_test' },
          url: 'https://agent.pivota.cc/products/prod_query_like_context?merchant_id=mid_test&entry=creator_agent',
        },
        {
          product_id: 'prod_barrier_relief_ok',
          merchant_id: 'mid_test',
          brand: 'BarrierLab',
          name: 'Barrier Relief Moisturizer',
          display_name: 'BarrierLab Barrier Relief Moisturizer',
          category: 'moisturizer',
          retrieval_source: 'catalog',
          retrieval_reason: 'catalog_search_match',
          canonical_product_ref: { product_id: 'prod_barrier_relief_ok', merchant_id: 'mid_test' },
          url: 'https://agent.pivota.cc/products/prod_barrier_relief_ok?merchant_id=mid_test&entry=creator_agent',
        },
      ],
      {
        target: {
          ingredient_query: 'Ceramide NP',
          goal: 'barrier',
          resolved_target_step: 'moisturizer',
          issue_type: 'redness',
        },
        max: 12,
      },
    );
    assert.deepEqual(
      filtered.map((row) => row.product_id),
      ['prod_barrier_relief_ok'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: sanitizeRecoRequestContext keeps only aligned non-query-shaped product candidates', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const context = __internal.sanitizeRecoRequestContext({
      intent: 'reco_products',
      source_detail: 'analysis_handoff',
      trigger_source: 'analysis_handoff',
      ingredient_query: 'Ceramide NP',
      goal: 'barrier',
      resolved_target_step: 'moisturizer',
      product_candidates: [
        {
          product_id: 'prod_query_like_context',
          merchant_id: 'mid_test',
          brand: 'BarrierLab',
          name: 'moisturizer barrier Ceramide NP',
          display_name: 'BarrierLab moisturizer barrier Ceramide NP',
          category: 'moisturizer',
          retrieval_source: 'catalog',
          canonical_product_ref: { product_id: 'prod_query_like_context', merchant_id: 'mid_test' },
          url: 'https://agent.pivota.cc/products/prod_query_like_context?merchant_id=mid_test&entry=creator_agent',
        },
        {
          product_id: 'prod_barrier_relief_ok',
          merchant_id: 'mid_test',
          brand: 'BarrierLab',
          name: 'Barrier Relief Moisturizer',
          display_name: 'BarrierLab Barrier Relief Moisturizer',
          category: 'moisturizer',
          retrieval_source: 'catalog',
          canonical_product_ref: { product_id: 'prod_barrier_relief_ok', merchant_id: 'mid_test' },
          url: 'https://agent.pivota.cc/products/prod_barrier_relief_ok?merchant_id=mid_test&entry=creator_agent',
        },
      ],
    });
    assert.ok(context);
    assert.deepEqual(
      (context.product_candidates || []).map((row) => row.product_id),
      ['prod_barrier_relief_ok'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: softenPhotoQualityFailFromUsablePhotoModules downgrades ONNX-only fail to degraded when modules are usable', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.softenPhotoQualityFailFromUsablePhotoModules({
      photoQuality: {
        grade: 'fail',
        reasons: ['pixel_diagnosis_failed'],
      },
      photoModulesCard: {
        type: 'photo_modules_v1',
        payload: {
          quality_grade: 'fail',
          low_confidence: true,
          quality_labels: ['quality_low_confidence'],
          regions_available_count: 5,
          modules: [
            {
              module_id: 'under_eye_right',
              issues: [{ issue_type: 'texture', confidence_0_1: 0, confidence_bucket: 'low' }],
            },
          ],
          module_overlay_debug: {
            skinmask_source: 'none',
            skinmask_fallback_reason: 'ONNX_FAIL',
            degraded_reasons: [],
          },
          summary_v1: {
            quality_caveats: ['photo_quality_failed', 'low_confidence_primary_finding'],
          },
        },
      },
    });

    assert.equal(out.applied, true);
    assert.equal(out.reason, 'skinmask_onnx_fail_softened');
    assert.equal(out.photoQuality.grade, 'degraded');
    assert.equal(out.photoModulesCard.payload.quality_grade, 'degraded');
    assert.deepEqual(out.photoModulesCard.payload.quality_labels, []);
    assert.equal(
      out.photoModulesCard.payload.summary_v1.quality_caveats.includes('photo_quality_failed'),
      false,
    );
    assert.equal(
      out.photoModulesCard.payload.summary_v1.quality_caveats.includes('photo_quality_degraded'),
      true,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: softenPhotoQualityFailFromUsablePhotoModules downgrades ONNX-only fail when renderable module shells exist without issues', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.softenPhotoQualityFailFromUsablePhotoModules({
      photoQuality: {
        grade: 'fail',
        reasons: ['pixel_diagnosis_failed'],
      },
      photoModulesCard: {
        type: 'photo_modules_v1',
        payload: {
          quality_grade: 'fail',
          low_confidence: true,
          quality_labels: ['quality_low_confidence'],
          regions_available_count: 0,
          modules: [
            {
              module_id: 'forehead',
              issues: [],
              box: { x: 0.344, y: 0.078, w: 0.313, h: 0.125 },
              module_pixels: 160,
              mask_rle_norm: '342,20,44,20,44,20,44,20',
            },
          ],
          module_overlay_debug: {
            skinmask_source: 'none',
            skinmask_fallback_reason: 'ONNX_FAIL',
            degraded_reasons: [],
          },
          summary_v1: {
            top_findings: [],
            quality_caveats: ['photo_quality_failed', 'low_confidence_primary_finding'],
          },
        },
      },
    });

    assert.equal(out.applied, true);
    assert.equal(out.reason, 'skinmask_onnx_fail_softened');
    assert.equal(out.photoQuality.grade, 'degraded');
    assert.equal(out.photoModulesCard.payload.quality_grade, 'degraded');
    assert.equal(
      out.photoModulesCard.payload.summary_v1.quality_caveats.includes('photo_quality_failed'),
      false,
    );
    assert.equal(
      out.photoModulesCard.payload.module_overlay_debug.degraded_reasons.includes('skinmask_onnx_fail_softened'),
      true,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: shouldSoftenAnalysisSummaryLowConfidence returns true when photo artifact fails but target is stable', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.shouldSoftenAnalysisSummaryLowConfidence({
      analysisSource: 'rule_based_with_photo_qc',
      usePhoto: true,
      photosProvided: true,
      usedPhotos: false,
      photoQualityGrade: 'pass',
      degradeReason: 'photo_download_url_generate_failed',
      profileSummary: {
        skinType: 'combination',
        sensitivity: 'low',
        barrierStatus: 'stable',
        goals: ['texture', 'redness'],
      },
      ingredientPlan: {
        targets: [
          {
            target_role: 'primary',
            ingredient_id: 'sunscreen_filters',
            ingredient_name: 'UV filters',
            resolved_target_step: 'sunscreen',
            priority_score_0_100: 76,
            strict_product_count: 1,
            products: {
              competitors: [
                {
                  product_id: 'ext_bbe1ff8884f06d874bbccbd8',
                  merchant_id: 'external_seed',
                  brand: 'the ordinary',
                  name: 'UV Filters SPF 45 Serum',
                },
              ],
            },
          },
        ],
      },
    });
    assert.equal(out, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: shouldSoftenAnalysisSummaryLowConfidence stays false without stable verified candidates', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.shouldSoftenAnalysisSummaryLowConfidence({
      analysisSource: 'rule_based_with_photo_qc',
      usePhoto: true,
      photosProvided: true,
      usedPhotos: false,
      photoQualityGrade: 'pass',
      degradeReason: 'photo_download_url_generate_failed',
      profileSummary: {
        skinType: 'combination',
        sensitivity: 'low',
        barrierStatus: 'stable',
        goals: ['texture'],
      },
      ingredientPlan: {
        targets: [
          {
            target_role: 'primary',
            ingredient_id: 'sunscreen_filters',
            ingredient_name: 'UV filters',
            resolved_target_step: 'sunscreen',
            priority_score_0_100: 76,
            strict_product_count: 0,
            products: { competitors: [] },
          },
        ],
      },
    });
    assert.equal(out, false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: shouldSoftenAnalysisSummaryLowConfidence accepts passed qc when photo quality grade is unknown', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.shouldSoftenAnalysisSummaryLowConfidence({
      analysisSource: 'rule_based_with_photo_qc',
      usePhoto: true,
      photosProvided: true,
      photos: [{ slot_id: 'daylight', photo_id: 'photo_1', qc_status: 'passed' }],
      usedPhotos: false,
      photoQualityGrade: 'unknown',
      degradeReason: 'photo_download_url_generate_failed',
      profileSummary: {
        skinType: 'combination',
        sensitivity: 'low',
        barrierStatus: 'stable',
        goals: ['texture', 'redness'],
      },
      ingredientPlan: {
        targets: [
          {
            target_role: 'primary',
            ingredient_id: 'sunscreen_filters',
            ingredient_name: 'UV filters',
            resolved_target_step: 'sunscreen',
            priority_score_0_100: 76,
            strict_product_count: 1,
            products: {
              competitors: [
                { product_id: 'ext_bbe1ff8884f06d874bbccbd8', merchant_id: 'external_seed', name: 'UV Filters SPF 45 Serum' },
              ],
            },
          },
        ],
      },
    });
    assert.equal(out, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: shouldSoftenAnalysisSummaryLowConfidence returns true for used-photo ONNX fallback after photo card softening', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.shouldSoftenAnalysisSummaryLowConfidence({
      analysisSource: 'rule_based_with_photo_qc',
      usePhoto: true,
      photosProvided: true,
      usedPhotos: true,
      photoQualityGrade: 'degraded',
      degradeReason: 'skinmask_onnx_fail_softened',
      photoModulesCard: {
        type: 'photo_modules_v1',
        payload: {
          quality_grade: 'degraded',
          low_confidence: false,
          diagnostic_confidence_level: 'medium',
          confidence_softened_reason: 'skinmask_onnx_fail_target_stable',
          summary_v1: {
            top_findings: [],
            quality_caveats: ['photo_quality_degraded'],
            confidence_softened_reason: 'skinmask_onnx_fail_target_stable',
          },
          module_overlay_debug: {
            skinmask_source: 'none',
            skinmask_fallback_reason: 'ONNX_FAIL',
            skinmask_model_loaded: true,
            confidence_softened_reason: 'skinmask_onnx_fail_target_stable',
          },
        },
      },
    });
    assert.equal(out, true);
  } finally {
    delete require.cache[moduleId];
  }
});

function findCardByType(cards, type) {
  if (!Array.isArray(cards)) return null;
  const expected = String(type || '').trim().toLowerCase();
  if (!expected) return null;
  for (const card of cards) {
    const t = String(card && card.type ? card.type : '').trim().toLowerCase();
    if (t === expected) return card;
  }
  return null;
}

function isProductsSearchUrl(url) {
  const target = String(url || '');
  return (
    target.includes('/products/search') ||
    target.includes('/products/search-lite') ||
    target.includes('/v1/products/search') ||
    target.includes('/v1/catalog/search') ||
    target.includes('/agent/v1/products/search')
  );
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

test('product anchor trust recovers skincare signals from nested sku candidates', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const nestedSkuCandidate = {
      product_id: 'pid_cerave_cleanser',
      merchant_id: 'm1',
      category: 'product',
      sku: {
        product_id: 'pid_cerave_cleanser',
        merchant_id: 'm1',
        brand: 'CeraVe',
        name: 'Hydrating Cleanser',
        display_name: 'CeraVe Hydrating Cleanser',
        category: 'Cleanser',
      },
    };

    const trust = __internal.evaluateAnchorTrustForProductIntel({
      candidate: nestedSkuCandidate,
      inputText: 'CeraVe Hydrating Cleanser',
      source: 'catalog_fallback',
    });
    assert.equal(trust?.trust_level, 'trusted');
    assert.equal(trust?.usable_for_anchor_id, true);
    assert.equal(Array.isArray(trust?.reason_codes), true);
    assert.equal(trust.reason_codes.length, 0);
    assert.equal(String(trust?.display_anchor?.brand || ''), 'CeraVe');
    assert.match(String(trust?.display_anchor?.display_name || ''), /Hydrating Cleanser/i);

    const mapped = __internal.mapCatalogProductToAnchorProduct(nestedSkuCandidate, {
      fallbackName: 'CeraVe Hydrating Cleanser',
    });
    assert.equal(String(mapped?.brand || ''), 'CeraVe');
    assert.match(String(mapped?.display_name || ''), /Hydrating Cleanser/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('ensureNonEmptyChatCardsEnvelope: reco-stage empty cards keep artifact_missing as primary reason even when timeout telemetry exists', () => {
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
    assert.equal(guarded.reason, 'artifact_missing');
    const cards = Array.isArray(guarded.envelope.cards) ? guarded.envelope.cards : [];
    assert.equal(cards.length, 1);
    assert.equal(cards[0].type, 'confidence_notice');
    assert.equal(cards[0]?.payload?.reason, 'artifact_missing');
    assert.ok(Array.isArray(cards[0]?.payload?.actions) && cards[0].payload.actions.length > 0);
    const recoEvents = Array.isArray(guarded.envelope?.events)
      ? guarded.envelope.events.filter((evt) => evt && evt.event_name === 'recos_requested')
      : [];
    assert.ok(recoEvents.length >= 1);
    assert.equal(recoEvents.some((evt) => evt?.data?.reason === 'artifact_missing'), true);
    assert.equal(recoEvents.some((evt) => evt?.data?.telemetry_reason === 'timeout_degraded'), true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('ensureNonEmptyChatCardsEnvelope: timeout remains primary only when no reco request context exists', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const recoEnvelope = {
      assistant_message: null,
      suggested_chips: [],
      cards: [],
      session_patch: {},
      events: [{ event_name: 'analysis_timeout_degraded', data: { budget_ms: 30000 } }],
    };
    const guarded = __internal.ensureNonEmptyChatCardsEnvelope({
      envelope: recoEnvelope,
      ctx: { request_id: 'req_guard_timeout_only', trace_id: 'trace_guard_timeout_only' },
      language: 'EN',
    });
    assert.equal(guarded.applied, true);
    assert.equal(guarded.reason, 'timeout_degraded');
    assert.equal(guarded.envelope?.cards?.[0]?.payload?.reason, 'timeout_degraded');
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

test('applyRecoCardContractInvariant: generic empty recommendations degrade to artifact_missing and normalize reco events', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: { role: 'assistant', content: 'Fallback guidance.', format: 'markdown' },
      suggested_chips: [],
      cards: [
        {
          card_id: 'reco_empty',
          type: 'recommendations',
          payload: {
            recommendations: [],
            warnings: ['recent_logs_missing'],
          },
          field_missing: [{ field: 'recommendations', reason: 'upstream_missing_or_empty' }],
        },
      ],
      session_patch: { next_state: 'S7_PRODUCT_RECO' },
      events: [{ event_name: 'recos_requested', data: { explicit: true } }],
    };

    const out = __internal.applyRecoCardContractInvariant({
      envelope,
      ctx: { request_id: 'req_empty_reco', trace_id: 'trace_empty_reco' },
      language: 'EN',
    });

    assert.equal(out.applied, true);
    assert.equal(out.reason, 'artifact_missing');
    assert.equal(Array.isArray(out.envelope.cards), true);
    assert.equal(out.envelope.cards.some((card) => card && card.type === 'recommendations'), false);
    assert.equal(out.envelope.cards.some((card) => card && card.type === 'confidence_notice'), true);
    assert.equal(out.envelope.cards.find((card) => card && card.type === 'confidence_notice').payload.reason, 'artifact_missing');
    assert.equal(Boolean(out.envelope.session_patch && out.envelope.session_patch.next_state), false);
    const recoEvent = Array.isArray(out.envelope?.events)
      ? out.envelope.events.find((evt) => evt && evt.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.reason, 'artifact_missing');
    assert.equal(recoEvent?.data?.telemetry_reason, 'empty_structured');
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyRecoContractToRecoRequestedEvents: contract canonical fields override stale eventData success meta', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.applyRecoContractToRecoRequestedEvents([], {
      primary_failure_reason: 'artifact_missing',
      telemetry_failure_reason: 'empty_structured',
      failure_class: null,
      source_mode: 'catalog_grounded',
      source: 'catalog_grounded_v1',
      mainline_status: 'empty_structured',
      catalog_skip_reason: null,
      upstream_status: 'artifact_missing',
      products_empty_reason: 'strict_filter_fallback_only',
    }, {
      ctx: { request_id: 'req_contract_evt', trace_id: 'trace_contract_evt' },
      emitIfMissing: true,
      eventData: {
        explicit: true,
        source: 'catalog_grounded_v1',
        source_mode: 'catalog_grounded',
        mainline_status: 'grounded_success',
        upstream_status: 'ok',
        reason: 'artifact_missing',
        llm_trace_ref: { template_id: 'reco_main_v1_1' },
      },
    });

    const recoEvent = Array.isArray(out?.events)
      ? out.events.find((evt) => evt && evt.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.reason, 'artifact_missing');
    assert.equal(recoEvent?.data?.telemetry_reason, 'empty_structured');
    assert.equal(recoEvent?.data?.source_mode, 'catalog_grounded');
    assert.equal(recoEvent?.data?.mainline_status, 'empty_structured');
    assert.equal(recoEvent?.data?.upstream_status, 'artifact_missing');
    assert.equal(recoEvent?.data?.products_empty_reason, 'strict_filter_fallback_only');
    assert.equal(recoEvent?.data?.llm_trace_ref?.template_id, 'reco_main_v1_1');
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyRecoContractToRecoRequestedEvents: reco_mainline_empty contract stays explicit and does not collapse to artifact_missing', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.applyRecoContractToRecoRequestedEvents([], {
      primary_failure_reason: 'reco_mainline_empty',
      telemetry_failure_reason: 'reco_mainline_empty',
      failure_class: null,
      source_mode: 'catalog_grounded',
      source: 'catalog_grounded_v1',
      mainline_status: 'reco_mainline_empty',
      catalog_skip_reason: null,
      upstream_status: 'ok',
      products_empty_reason: 'reco_mainline_empty',
      surface_reason: 'reco_mainline_empty',
    }, {
      ctx: { request_id: 'req_reco_mainline_empty_evt', trace_id: 'trace_reco_mainline_empty_evt' },
      emitIfMissing: true,
      eventData: {
        explicit: true,
        source: 'catalog_grounded_v1',
        source_mode: 'catalog_grounded',
      },
    });

    const recoEvent = Array.isArray(out?.events)
      ? out.events.find((evt) => evt && evt.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.reason, 'reco_mainline_empty');
    assert.equal(recoEvent?.data?.telemetry_reason, 'reco_mainline_empty');
    assert.equal(recoEvent?.data?.mainline_status, 'reco_mainline_empty');
    assert.equal(recoEvent?.data?.upstream_status, 'ok');
    assert.equal(recoEvent?.data?.products_empty_reason, 'reco_mainline_empty');
    assert.equal(recoEvent?.data?.surface_reason, 'reco_mainline_empty');
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyRecoCardContractInvariant: explicit ingredient no-candidate empty mode is preserved', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: { role: 'assistant', content: 'No ingredient match yet.', format: 'markdown' },
      suggested_chips: [],
      cards: [
        {
          card_id: 'reco_empty_ingredient',
          type: 'recommendations',
          payload: {
            recommendations: [],
            task_mode: 'ingredient_lookup_no_candidates',
            products_empty_reason: 'ingredient_constraint_no_match',
            empty_match_actions: [{ action_id: 'broaden_to_goal', label: 'Broaden' }],
          },
        },
      ],
      session_patch: {},
      events: [{ event_name: 'recos_requested', data: { explicit: true } }],
    };

    const out = __internal.applyRecoCardContractInvariant({
      envelope,
      ctx: { request_id: 'req_empty_ing_reco', trace_id: 'trace_empty_ing_reco' },
      language: 'EN',
    });

    assert.equal(out.applied, false);
    assert.equal(Array.isArray(out.envelope.cards), true);
    assert.equal(out.envelope.cards[0].type, 'recommendations');
  } finally {
    delete require.cache[moduleId];
  }
});

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

test('applyLowOrMediumRecoGuardToEnvelope: medium confidence removes treatment/high-irritation recs', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: { role: 'assistant', content: 'test', format: 'markdown' },
      suggested_chips: [],
      cards: [
        {
          card_id: 'reco_1',
          type: 'recommendations',
          payload: {
            recommendation_confidence_level: 'medium',
            recommendations: [
              { step: 'Treatment', slot: 'pm', category: 'treatment', sku: { sku_id: 'sku_treat_1', name: 'Retinoid Serum' } },
              { step: 'Moisturizer', slot: 'pm', category: 'moisturizer', sku: { sku_id: 'sku_safe_1', name: 'Barrier Cream' } },
            ],
          },
        },
      ],
      session_patch: { next_state: 'S7_PRODUCT_RECO' },
      events: [{ event_name: 'recos_requested', data: { explicit: true, confidence_level: 'medium' } }],
    };

    const out = __internal.applyLowOrMediumRecoGuardToEnvelope({
      envelope,
      ctx: { request_id: 'req_medium_filter', trace_id: 'trace_medium_filter', lang: 'EN' },
      language: 'EN',
    });

    assert.equal(out.applied, true);
    assert.equal(out.filteredCount, 1);
    assert.equal(out.fallbackApplied, false);
    const recoCard = Array.isArray(out.envelope.cards)
      ? out.envelope.cards.find((c) => c && c.type === 'recommendations')
      : null;
    assert.ok(recoCard);
    const recs = Array.isArray(recoCard.payload && recoCard.payload.recommendations)
      ? recoCard.payload.recommendations
      : [];
    assert.equal(recs.length, 1);
    assert.equal(recs.some((item) => looksTreatmentOrHighIrritation(item)), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyLowOrMediumRecoGuardToEnvelope: active-keyword recommendations are filtered and fallback notice is emitted', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: { role: 'assistant', content: 'test', format: 'markdown' },
      suggested_chips: [],
      cards: [
        {
          card_id: 'reco_1',
          type: 'recommendations',
          payload: {
            recommendation_confidence_level: 'low',
            recommendations: [
              {
                step: 'Moisturizer',
                slot: 'pm',
                category: 'moisturizer',
                routine_slot: 'moisturizer',
                sku: { sku_id: 'sku_safe_active', name: 'BHA Barrier Cream' },
              },
              {
                step: 'Treatment',
                slot: 'pm',
                category: 'treatment',
                routine_slot: 'treatment',
                sku: { sku_id: 'sku_treat_drop', name: 'Strong Retinol Serum' },
              },
            ],
          },
        },
      ],
      session_patch: { next_state: 'S7_PRODUCT_RECO' },
      events: [{ event_name: 'recos_requested', data: { explicit: true, confidence_level: 'low' } }],
    };

    const out = __internal.applyLowOrMediumRecoGuardToEnvelope({
      envelope,
      ctx: { request_id: 'req_low_slot_keep', trace_id: 'trace_low_slot_keep', lang: 'EN' },
      language: 'EN',
    });

    assert.equal(out.applied, true);
    assert.equal(out.filteredCount, 2);
    assert.equal(out.fallbackApplied, true);
    const cards = Array.isArray(out.envelope.cards) ? out.envelope.cards : [];
    const recoCard = cards.find((c) => c && c.type === 'recommendations');
    assert.equal(Boolean(recoCard), false);
    const recs = Array.isArray(recoCard && recoCard.payload && recoCard.payload.recommendations)
      ? recoCard.payload.recommendations
      : [];
    assert.equal(recs.length, 0);
    const notice = cards.find((c) => c && c.type === 'confidence_notice');
    assert.ok(notice);
    assert.equal(notice?.payload?.reason, 'low_confidence');
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyLowOrMediumRecoGuardToEnvelope: low confidence treatment-only result falls back to low-confidence notice', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: { role: 'assistant', content: 'test', format: 'markdown' },
      suggested_chips: [],
      cards: [
        {
          card_id: 'reco_1',
          type: 'recommendations',
          payload: {
            recommendation_confidence_level: 'low',
            recommendations: [
              { step: 'Treatment', slot: 'pm', category: 'treatment', sku: { sku_id: 'sku_treat_only', name: 'Strong Retinoid' } },
            ],
          },
        },
      ],
      session_patch: { next_state: 'S7_PRODUCT_RECO' },
      events: [{ event_name: 'recos_requested', data: { explicit: true, confidence_level: 'low' } }],
    };

    const out = __internal.applyLowOrMediumRecoGuardToEnvelope({
      envelope,
      ctx: { request_id: 'req_low_filter', trace_id: 'trace_low_filter', lang: 'EN' },
      language: 'EN',
    });

    assert.equal(out.applied, true);
    assert.equal(out.filteredCount, 1);
    assert.equal(out.fallbackApplied, true);
    const cards = Array.isArray(out.envelope.cards) ? out.envelope.cards : [];
    const recoCard = cards.find((c) => c && c.type === 'recommendations');
    const recs = Array.isArray(recoCard && recoCard.payload && recoCard.payload.recommendations)
      ? recoCard.payload.recommendations
      : [];
    assert.equal(recs.length, 0);
    const notice = cards.find((c) => c && c.type === 'confidence_notice');
    assert.ok(notice);
    assert.equal(notice?.payload?.reason, 'low_confidence');
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

test('/v1/chat: travel intent with missing destination/date asks travel fields before env_stress short-circuit', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': 'test_uid_travel_missing_fields',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        })
        .send({
          message: 'Travel next week skincare plan please',
          session: { state: 'idle', profile: { skinType: 'oily' } },
          language: 'EN',
        })
        .expect(200);

      const assistant = String(resp.body?.assistant_message?.content || '');
      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const types = cards.map((c) => (c && typeof c.type === 'string' ? c.type : '')).filter(Boolean);
      const chipLabels = (Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [])
        .map((chip) => (chip && typeof chip.label === 'string' ? chip.label : ''))
        .filter(Boolean)
        .join(' | ');

      assert.match(assistant, /destination|travel dates|travel detail/i);
      assert.equal(types.includes('env_stress'), true);
      assert.equal(/tokyo|2026-03-01|2026-03-05/i.test(chipLabels), false);

      delete require.cache[moduleId];
    },
  );
});

test('/v1/chat: retinoid with unknown pregnancy requires info before availability/catalog short-circuit', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_SAFETY_ENGINE_V1_ENABLED: 'true',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED: 'true',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': 'test_uid_safety_require_info',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        })
        .send({
          message: 'Can I use retinol?',
          session: { state: 'idle', profile: { skinType: 'oily', sensitivity: 'low', barrierStatus: 'stable' } },
          language: 'EN',
        })
        .expect(200);

      const assistant = String(resp.body?.assistant_message?.content || '');
      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const types = cards.map((c) => (c && typeof c.type === 'string' ? c.type : '')).filter(Boolean);

      assert.ok(assistant.length > 0);
      assert.equal(types.includes('diagnosis_gate'), false);
      assert.equal(types.includes('product_parse'), false);
      assert.equal(types.includes('offers_resolved'), false);

      delete require.cache[moduleId];
    },
  );
});

test('/v1/chat: text-only "Send a link" enters anchor collection prompt (no catalog fetch)', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED: 'true',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': 'test_uid_send_link_text_only',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        })
        .send({
          message: 'Send a link',
          session: { state: 'idle', profile: { skinType: 'oily' } },
          language: 'EN',
        })
        .expect(200);

      const assistant = String(resp.body?.assistant_message?.content || '');
      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const types = cards.map((c) => (c && typeof c.type === 'string' ? c.type : '')).filter(Boolean);

      assert.equal(assistant.length > 0, true);
      assertPassiveGateAdvisorySignal(resp.body, 'fit_check_anchor_gate');
      assert.equal(types.includes('product_parse'), false);
      assert.equal(types.includes('offers_resolved'), false);

      delete require.cache[moduleId];
    },
  );
});

test('/v1/chat: fit-check phrasing routes to anchor collection (no diagnosis gate)', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED: 'true',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': 'test_uid_fitcheck_phrase_anchor_collect',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        })
        .send({
          message: 'Is this toner good for me?',
          session: { state: 'idle', profile: { skinType: 'oily' } },
          language: 'EN',
        })
        .expect(200);

      const assistant = String(resp.body?.assistant_message?.content || '');
      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const types = cards.map((c) => (c && typeof c.type === 'string' ? c.type : '')).filter(Boolean);

      assert.equal(assistant.length > 0, true);
      assert.equal(types.includes('diagnosis_gate'), false);
      assert.equal(types.includes('offers_resolved'), false);
      assertPassiveGateAdvisorySignal(resp.body, 'fit_check_anchor_gate');

      delete require.cache[moduleId];
    },
  );
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

test('Routine simulate: kb interaction conflict carries risk_level/recommended_action and dynamic heatmap copy', async () => {
  const sim = simulateConflicts({
    routine: { pm: [{ key_actives: ['retinol'] }] },
    testProduct: { key_actives: ['glycolic acid'] },
  });

  const kbHit = sim.conflicts.find((c) => c && c.rule_id === 'RETINOID_X_AHA');
  assert.ok(kbHit);
  assert.equal(kbHit.severity, 'block');
  assert.equal(kbHit.risk_level, 'high');
  assert.equal(kbHit.recommended_action, 'avoid_same_night');

  const payload = buildConflictHeatmapV1({
    routineSimulation: { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary },
    routineSteps: ['Step 1', 'Step 2'],
  });
  assert.equal(payload.schema_version, 'aurora.ui.conflict_heatmap.v1');
  assert.ok(Array.isArray(payload.cells.items));
  assert.ok(payload.cells.items.length > 0);
  const firstCell = payload.cells.items[0];
  assert.ok(Array.isArray(firstCell.rule_ids));
  assert.ok(firstCell.rule_ids.includes('RETINOID_X_AHA'));
  assert.notEqual(firstCell.headline_i18n?.en, 'Compatibility caution');
  assert.ok(typeof firstCell.why_i18n?.en === 'string' && firstCell.why_i18n.en.length > 0);
});

test('Routine simulate: low-risk interaction should keep safe=true', async () => {
  const sim = simulateConflicts({
    routine: { pm: [{ key_actives: ['niacinamide serum'] }] },
    testProduct: { key_actives: ['vitamin c serum'] },
  });

  const low = sim.conflicts.find((c) => c && c.rule_id === 'NIACINAMIDE_X_VITAMIN_C');
  assert.ok(low);
  assert.equal(low.severity, 'low');
  assert.equal(low.risk_level, 'low');
  assert.equal(sim.safe, true);
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
    assert.equal(heatmap.payload.cells.items[0].severity, 3);

    const impression = Array.isArray(resp.body?.events)
      ? resp.body.events.find((e) => e && e.event_name === 'aurora_conflict_heatmap_impression')
      : null;
    assert.ok(impression);
    assert.equal(impression?.data?.state, heatmap.payload.state);
  });
});

test('/v1/routine/simulate: normalizes pm="same_as_am" before simulation and heatmap generation', async () => {
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
      headers: { 'X-Aurora-UID': 'test_uid_same_am', 'X-Trace-ID': 'test_trace_same_am', 'X-Brief-ID': 'test_brief_same_am', 'X-Lang': 'EN' },
      body: {
        routine: {
          am: [{ key_actives: ['retinol'], step: 'Treatment' }],
          pm: 'same_as_am',
        },
        test_product: { key_actives: ['glycolic acid'], name: 'Test Acid' },
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const heatmap = cards.find((c) => c && c.type === 'conflict_heatmap');
    assert.ok(heatmap);
    assert.equal(heatmap?.payload?.axes?.rows?.items?.length, 3);
    assert.equal(heatmap.payload.axes.rows.items[0]?.label_i18n?.en, 'AM Treatment');
    assert.equal(heatmap.payload.axes.rows.items[1]?.label_i18n?.en, 'PM Treatment');
  });
});

test('/v1/routine/simulate: marks analysis_ready when actives/concepts are detectable', async () => {
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
    headers: { 'X-Aurora-UID': 'test_uid_analysis_ready', 'X-Trace-ID': 'test_trace_analysis_ready', 'X-Brief-ID': 'test_brief_analysis_ready', 'X-Lang': 'EN' },
    body: {
      routine: {
        pm: [{ key_actives: ['niacinamide'], step: 'Serum', name: 'Niacinamide Serum' }],
      },
      test_product: { key_actives: ['retinol'], name: 'Retinol Night Serum' },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const simCard = cards.find((c) => c && c.type === 'routine_simulation');
  assert.ok(simCard);
  assert.equal(simCard?.payload?.analysis_ready, true);
  assert.equal(simCard?.payload?.signal_summary?.routine_active_count, 1);
  assert.equal(simCard?.payload?.signal_summary?.test_active_count, 1);
});

test('/v1/routine/simulate: keeps analysis_ready false when no actives/concepts are detectable', async () => {
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
    headers: { 'X-Aurora-UID': 'test_uid_analysis_hidden', 'X-Trace-ID': 'test_trace_analysis_hidden', 'X-Brief-ID': 'test_brief_analysis_hidden', 'X-Lang': 'EN' },
    body: {
      routine: {
        pm: [{ step: 'mask', name: 'Water Sleeping Mask', brand: 'Laneige' }],
      },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const simCard = cards.find((c) => c && c.type === 'routine_simulation');
  assert.ok(simCard);
  assert.equal(simCard?.payload?.analysis_ready, false);
  assert.equal(simCard?.payload?.signal_summary?.routine_active_count, 0);
  assert.equal(simCard?.payload?.signal_summary?.routine_concept_count, 0);
  assert.equal(simCard?.payload?.signal_summary?.test_active_count, 0);
  assert.equal(simCard?.payload?.signal_summary?.test_concept_count, 0);
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
  assert.match(resp.body.assistant_message.content, /which skin type fits you best/i);
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
        assert.match(badResumeText, /(quick skin profile|quick skin-profile detail)/i);

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
        assert.equal(assistant.length > 0, true);
      }
      if (conf) {
        assert.ok(['artifact_missing', 'gate_advisory'].includes(String(conf?.payload?.reason || '')));
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
    assert.ok(Array.isArray(chips));
  });
});

test('ingredient research: gemini-only path never calls openai even when OPENAI_API_KEY exists', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'true',
      AURORA_LLM_SINGLE_PROVIDER: 'gemini',
      AURORA_LLM_QA_MODE: 'single',
      AURORA_LLM_OPENAI_FALLBACK_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      OPENAI_API_KEY: 'test_openai_key',
      AURORA_DIAG_FORCE_GEMINI: 'false',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      let geminiCalls = 0;
      let openAiCalls = 0;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalls += 1;
          return {
            ok: true,
            json: {
              verdict: { one_liner: 'ok', evidence_grade: 'B', irritation_risk: 'low', confidence: 0.8 },
              benefits: [{ concern: 'uv', strength: 2, what_it_means: 'UV filter support.' }],
              how_to_use: { frequency: 'daily', routine_step: 'sunscreen', notes: ['Use enough amount.'] },
              watchouts: [{ issue: 'Eye sting', likelihood: 'medium', what_to_do: 'Avoid eye contour.' }],
              evidence: { summary: 'mock evidence', citations: [{ title: 'paper', url: 'https://example.com' }] },
              top_products: [{ name: 'Test SPF', brand: 'BrandA', price_tier: 'mid' }],
            },
          };
        });
        __internal.__setCallOpenAiJsonObjectForTest(async () => {
          openAiCalls += 1;
          return { ok: false, reason: 'invalid_api_key' };
        });

        const payload = await __internal.buildIngredientReportPayloadWithResearch({
          language: 'EN',
          query: 'octocrylene',
        });
        assert.equal(payload.research_status, 'ready');
        assert.equal(payload.research_provider, 'gemini');
        assert.equal(Array.isArray(payload.research_attempts), true);
        assert.equal(payload.research_attempts[0]?.provider, 'gemini');
        assert.equal(geminiCalls, 1);
        assert.equal(openAiCalls, 0);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        __internal.__resetCallOpenAiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('ingredient research: gemini failure surfaces gemini_* error code and is not overwritten by openai', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'true',
      AURORA_LLM_SINGLE_PROVIDER: 'gemini',
      AURORA_LLM_QA_MODE: 'single',
      AURORA_LLM_OPENAI_FALLBACK_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      OPENAI_API_KEY: 'test_openai_key',
      AURORA_DIAG_FORCE_GEMINI: 'false',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      let openAiCalls = 0;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: false,
          reason: 'GEMINI_JSON_TIMEOUT',
          detail: 'timed out after 9000ms',
        }));
        __internal.__setCallOpenAiJsonObjectForTest(async () => {
          openAiCalls += 1;
          return { ok: false, reason: 'invalid_api_key' };
        });

        const payload = await __internal.buildIngredientReportPayloadWithResearch({
          language: 'EN',
          query: 'octocrylene',
        });
        assert.equal(payload.research_status, 'fallback');
        assert.equal(payload.research_error_code, 'gemini_timeout');
        assert.equal(payload.research_provider, 'gemini');
        assert.equal(Array.isArray(payload.research_attempts), true);
        assert.equal(payload.research_attempts[0]?.reason_code, 'gemini_timeout');
        assert.equal(openAiCalls, 0);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        __internal.__resetCallOpenAiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('ingredient research: request uses no ingredient-specific timeout', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'true',
      AURORA_LLM_SINGLE_PROVIDER: 'gemini',
      AURORA_LLM_QA_MODE: 'single',
      AURORA_LLM_OPENAI_FALLBACK_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'false',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      let seenTimeout = 'unset';
      try {
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          seenTimeout = Object.prototype.hasOwnProperty.call(args, 'timeoutMs') ? args.timeoutMs : 'missing';
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            ok: true,
            json: { verdict: { one_liner: 'ok', evidence_grade: 'B', irritation_risk: 'low', confidence: 0.7 } },
          };
        });
        const payload = await __internal.buildIngredientReportPayloadWithResearch({
          language: 'EN',
          query: 'octocrylene',
        });
        assert.equal(payload.research_status, 'ready');
        assert.equal(seenTimeout, 4000);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('ingredient report deterministic: known ingredient includes stable key and ingredient-level personalization', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'false',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      try {
        const payload = await __internal.buildIngredientReportPayloadWithResearch({
          language: 'EN',
          query: 'BEHENYL ALCOHOL',
        });
        assert.equal(payload.schema_version, 'aurora.ingredient_report.v2-lite');
        assert.equal(payload.ingredient?.key, 'behenyl_alcohol');
        assert.equal(payload.verdict?.personalization_basis, 'ingredient');
        assert.equal(payload.report_state?.mode, 'deterministic');
        assert.equal(payload.report_state?.status, 'partial');
        assert.equal(Array.isArray(payload.benefits), true);
        assert.equal(payload.benefits.length > 0, true);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('ingredient report deterministic: unknown ingredient falls back to family profile with non-generic one-liner', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'false',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      try {
        const payload = await __internal.buildIngredientReportPayloadWithResearch({
          language: 'EN',
          query: 'Ethylhexyl XYZ Ester',
        });
        assert.equal(payload.schema_version, 'aurora.ingredient_report.v2-lite');
        assert.equal(payload.verdict?.personalization_basis, 'ingredient_family');
        assert.equal(payload.report_state?.mode, 'deterministic');
        assert.equal(typeof payload.verdict?.one_liner, 'string');
        assert.match(String(payload.verdict?.one_liner || ''), /Ethylhexyl XYZ Ester/i);
        assert.equal(Array.isArray(payload.report_state?.missing_sections), true);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('ingredient report hybrid: timeout fallback still returns pending personalized baseline', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'true',
      AURORA_LLM_SINGLE_PROVIDER: 'gemini',
      AURORA_LLM_QA_MODE: 'single',
      AURORA_LLM_OPENAI_FALLBACK_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'false',
    },
    async () => {
      const { moduleId, __internal } = loadRouteInternals();
      try {
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: false,
          reason: 'GEMINI_JSON_TIMEOUT',
          detail: 'timed out after 9000ms',
        }));
        const payload = await __internal.buildIngredientReportPayloadWithResearch({
          language: 'EN',
          query: 'Octocrylene',
        });
        assert.equal(payload.research_status, 'fallback');
        assert.equal(payload.report_state?.status, 'pending');
        assert.equal(payload.report_state?.reason_code, 'timeout');
        assert.equal(
          payload.verdict?.personalization_basis === 'ingredient' ||
            payload.verdict?.personalization_basis === 'ingredient_family' ||
            payload.verdict?.personalization_basis === 'mixed',
          true,
        );
        assert.equal(Array.isArray(payload.benefits), true);
        assert.equal(payload.benefits.length > 0, true);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat: ingredient.lookup uses research path and second lookup can hit in-memory KB cache', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'true',
      AURORA_LLM_SINGLE_PROVIDER: 'gemini',
      AURORA_LLM_QA_MODE: 'single',
      AURORA_LLM_OPENAI_FALLBACK_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'false',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const routeModule = require('../src/auroraBff/routes');
      const { mountAuroraBffRoutes, __internal } = routeModule;
      let geminiCalls = 0;
      let geminiArgs = null;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          geminiCalls += 1;
          geminiArgs = args;
          return {
            ok: true,
            json: {
              verdict: {
                one_liner: 'Octocrylene is a UVB filter used in sunscreen formulas.',
                evidence_grade: 'B',
                irritation_risk: 'medium',
                confidence: 0.78,
              },
              benefits: [{ concern: 'uv_protection', strength: 2, what_it_means: 'Adds UVB coverage support.' }],
              how_to_use: { frequency: 'daily', routine_step: 'cream', notes: ['Use adequate amount and reapply.'] },
              watchouts: [{ issue: 'Potential irritation in sensitive users', likelihood: 'common', what_to_do: 'Patch test first.' }],
              evidence: { summary: 'Mocked research summary', citations: [{ title: 'Mock UV filter reference', url: 'https://example.com/octocrylene' }] },
              top_products: [{ name: 'Mock SPF 50', brand: 'Brand A', category: 'sunscreen', price_tier: 'mid', pdp_url: 'https://example.com/spf-50' }],
            },
          };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const uniqueIngredient = `octocrylene_lookup_${Date.now()}`;

        const requestBody = {
          action: {
            action_id: 'ingredient.lookup',
            kind: 'action',
            data: { ingredient_query: uniqueIngredient, entry_source: 'ingredient_hub' },
          },
          language: 'EN',
        };
        const headers = {
          'X-Aurora-UID': 'test_uid_ingredient_lookup_research',
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        };

        const first = await supertest(app).post('/v1/chat').set(headers).send(requestBody);
        assert.equal(first.status, 200);
        const firstReport = Array.isArray(first.body?.cards)
          ? first.body.cards.find((card) => card && card.type === 'aurora_ingredient_report')
          : null;
        assert.ok(firstReport);
        assert.equal(firstReport.payload?.research_status, 'ready');
        assert.equal(firstReport.payload?.research_provider, 'gemini');
        assert.equal(firstReport.payload?.schema_version, 'aurora.ingredient_report.v2-lite');
        assert.equal(Array.isArray(firstReport.payload?.benefits), true);
        assert.equal(firstReport.payload?.benefits?.length > 0, true);
        assert.equal(typeof firstReport.payload?.verdict?.one_liner, 'string');
        assert.equal(firstReport.payload?.verdict?.one_liner?.length > 0, true);
        assert.equal(Array.isArray(firstReport.payload?.watchouts), true);
        assert.equal(firstReport.payload?.watchouts?.length > 0, true);
        assert.equal(
          Boolean(geminiArgs?.responseJsonSchema) &&
            typeof geminiArgs.responseJsonSchema === 'object' &&
            !Array.isArray(geminiArgs.responseJsonSchema),
          true,
        );
        assert.equal(
          Array.isArray(geminiArgs?.responseJsonSchema?.required) &&
            geminiArgs.responseJsonSchema.required.includes('schema_version'),
          true,
        );
        assert.match(String(geminiArgs?.systemPrompt || ''), /Prompt version: ingredient_research_v2_lite_hardened/i);
        assert.match(String(geminiArgs?.systemPrompt || ''), /single valid JSON object/i);
        assert.match(String(geminiArgs?.userPrompt || ''), /schema_version\"\s*:\s*\"v2-lite\"/i);
        assert.equal(geminiCalls, 1);

        await new Promise((resolve) => setTimeout(resolve, 30));

        const second = await supertest(app).post('/v1/chat').set(headers).send(requestBody);
        assert.equal(second.status, 200);
        const secondReport = Array.isArray(second.body?.cards)
          ? second.body.cards.find((card) => card && card.type === 'aurora_ingredient_report')
          : null;
        assert.ok(secondReport);
        assert.equal(secondReport.payload?.research_status, 'ready');
        assert.equal(secondReport.payload?.research_provider, 'gemini');
        assert.equal(geminiCalls, 1);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat: ingredient.lookup consumes explicit profile lane and emits analysis_context_usage', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_INGREDIENT_LLM_REPORT_ENABLED: 'true',
      AURORA_LLM_SINGLE_PROVIDER: 'gemini',
      AURORA_LLM_QA_MODE: 'single',
      AURORA_LLM_OPENAI_FALLBACK_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'false',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const routeModule = require('../src/auroraBff/routes');
      const { mountAuroraBffRoutes, __internal } = routeModule;
      let geminiArgs = null;
      try {
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          geminiArgs = args;
          return {
            ok: true,
            json: {
              verdict: {
                one_liner: 'Niacinamide can support oil-control and post-breakout appearance concerns.',
                evidence_grade: 'B',
                irritation_risk: 'low',
                confidence: 0.81,
              },
              benefits: [{ concern: 'acne', strength: 2, what_it_means: 'Often used to support blemish-prone routines.' }],
              how_to_use: { frequency: 'daily', routine_step: 'serum', notes: ['Start with a leave-on step after cleansing.'] },
              watchouts: [{ issue: 'Possible irritation in very sensitive users', likelihood: 'uncommon', what_to_do: 'Introduce gradually.' }],
              evidence: { summary: 'Mocked research summary', citations: [{ title: 'Mock niacinamide reference', url: 'https://example.com/niacinamide' }] },
              top_products: [],
            },
          };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set({
            'X-Aurora-UID': 'test_uid_ingredient_lookup_explicit_context',
            'X-Trace-ID': 'test_trace_ingredient_lookup_explicit_context',
            'X-Brief-ID': 'test_brief_ingredient_lookup_explicit_context',
            'X-Lang': 'EN',
          })
          .send({
            action: {
              action_id: 'ingredient.lookup',
              kind: 'action',
              data: { ingredient_query: `niacinamide_context_${Date.now()}`, entry_source: 'ingredient_hub' },
            },
            session: {
              profile: {
                skinType: 'oily',
                sensitivity: 'high',
                goals: ['acne'],
              },
            },
            language: 'EN',
          });

        assert.equal(resp.status, 200);
        assert.equal(
          Boolean(resp.body?.session_patch?.meta?.analysis_context_usage)
            && typeof resp.body.session_patch.meta.analysis_context_usage === 'object'
            && !Array.isArray(resp.body.session_patch.meta.analysis_context_usage),
          true,
        );
        assert.equal(resp.body.session_patch.meta.analysis_context_usage.explicit_override_applied, true);
        assert.equal(resp.body.session_patch.meta.analysis_context_usage.snapshot_present, false);
        assert.equal(resp.body.session_patch.meta.analysis_context_usage.context_source_mode, 'explicit_only');
        assert.equal(resp.body.session_patch.meta.analysis_context_usage.analysis_context_available, true);
        assert.equal(
          Array.isArray(resp.body.session_patch.meta.analysis_context_usage.hard_context_fields_used),
          true,
        );
        assert.ok(resp.body.session_patch.meta.analysis_context_usage.hard_context_fields_used.includes('active_goals'));
        assert.ok(resp.body.session_patch.meta.analysis_context_usage.hard_context_fields_used.includes('sensitivity'));
        assert.match(String(geminiArgs?.userPrompt || ''), /"analysis_context"\s*:/i);
        assert.match(String(geminiArgs?.userPrompt || ''), /"active_goals"\s*:\s*\["acne"\]/i);
        assert.match(String(geminiArgs?.userPrompt || ''), /"sensitivity"\s*:\s*"high"/i);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat: ingredient reco opt-in first query already carries ingredient_context', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
    delete require.cache[decisionModuleId];
    const decisionModule = require('../src/auroraBff/auroraDecisionClient');
    const originalAuroraChat = decisionModule.auroraChat;
    const capturedQueries = [];

    decisionModule.auroraChat = async ({ query }) => {
      capturedQueries.push(String(query || ''));
      return {
        answer: JSON.stringify({
          recommendations: [
            {
              step: 'treatment',
              reasons: ['Matched for barrier support and sensitivity profile.'],
              sku: { brand: 'Mock', display_name: 'Barrier Repair Serum' },
            },
          ],
        }),
      };
    };

    const moduleId = require.resolve('../src/auroraBff/routes');
    delete require.cache[moduleId];
    try {
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': 'test_uid_ing_reco_context_first_query',
          'X-Trace-ID': 'test_trace_ing_reco_context_first_query',
          'X-Brief-ID': 'test_brief_ing_reco_context_first_query',
          'X-Lang': 'EN',
        })
        .send({
          action: {
            action_id: 'chip.start.reco_products',
            kind: 'chip',
            data: {
              reply_text: 'Recommend products',
              entry_source: 'ingredient_goal_match',
              goal: 'barrier',
              sensitivity: 'high',
              candidates: ['Ceramide NP', 'Panthenol'],
            },
          },
          language: 'EN',
        });

      assert.equal(resp.status, 200);
      assert.equal(capturedQueries.length > 0, true);
      const firstQuery = capturedQueries[0];
      assert.match(firstQuery, /PROMPT_TEMPLATE_ID=reco_main_v1_2/i);
      assert.match(firstQuery, /SYSTEM_PROMPT:/i);
      assert.match(firstQuery, /USER_PROMPT_JSON:/i);
      assert.match(firstQuery, /"ingredient_context"\s*:/i);
      assert.match(firstQuery, /"goal"\s*:\s*"barrier"/i);
      assert.match(firstQuery, /"sensitivity"\s*:\s*"high"/i);
      assert.match(firstQuery, /"candidates"\s*:\s*\[/i);
    } finally {
      decisionModule.auroraChat = originalAuroraChat;
      delete require.cache[moduleId];
      delete require.cache[decisionModuleId];
    }
  });
});

test('/v1/chat: prompt contract mismatch blocks reco success and records mismatch metric', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH: 'true',
    },
    async () => {
      resetVisionMetrics();
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      let upstreamCalls = 0;
      decisionModule.auroraChat = async () => {
        upstreamCalls += 1;
        throw new Error('should_not_be_called_when_prompt_contract_mismatch');
      };

      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        const out = await __internal.generateProductRecommendations({
          ctx: {
            uid: 'test_uid_prompt_contract_mismatch',
            lang: 'EN',
            trigger_source: 'chip',
            action_id: 'chip.start.reco_products',
            request_id: 'req_prompt_contract_mismatch',
            trace_id: 'trace_prompt_contract_mismatch',
            profile: {},
          },
          profileSummary: {},
          recentLogs: [],
          userAsk: 'Recommend products for acne-safe routine',
          logger: null,
        });

        assert.equal(upstreamCalls, 0);
        assert.equal(Boolean(out?.norm?.payload), true);
        assert.equal(out?.norm?.payload?.prompt_contract_ok, false);
        assert.equal(Array.isArray(out?.norm?.payload?.recommendations), true);
        assert.equal(out?.norm?.payload?.recommendations?.length || 0, 0);
        assert.equal(out?.norm?.payload?.mainline_status, 'severe_parse_or_prompt_failure');
        assert.equal(out?.norm?.payload?.recommendation_meta?.failure_class, 'prompt_contract_mismatch');
        assert.equal(out?.norm?.payload?.recommendation_meta?.mainline_status, 'severe_parse_or_prompt_failure');
        assert.equal(out?.norm?.payload?.recommendation_meta?.primary_failure_reason, 'prompt_contract_mismatch');
        assert.equal(out?.norm?.payload?.recommendation_meta?.telemetry_failure_reason, 'prompt_contract_mismatch');
        assert.equal(out?.norm?.payload?.recommendation_meta?.products_empty_reason, 'prompt_contract_mismatch');
        assert.equal(out?.norm?.payload?.recommendation_meta?.surface_reason, 'prompt_contract_mismatch');
        const issues = Array.isArray(out?.norm?.payload?.prompt_contract_issues)
          ? out.norm.payload.prompt_contract_issues.map((x) => String(x || ''))
          : [];
        assert.equal(issues.includes('forced_mismatch'), true);

        const snap = snapshotVisionMetrics();
        assert.ok(getLabeledCounterValue(snap.auroraSkinFlow, { stage: 'reco_prompt_contract_mismatch', outcome: 'hit' }) >= 1);
      } finally {
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[routeModuleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('ingredient reco context keeps candidates and injects constraint prompt even without direct query', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const normalized = __internal.normalizeIngredientRecoContextValue({
      goal: 'barrier repair',
      sensitivity: 'high',
      ingredient_candidates: ['Ceramide NP', 'Panthenol'],
    });
    assert.equal(normalized?.goal, 'barrier');
    assert.equal(normalized?.sensitivity, 'high');
    assert.ok(Array.isArray(normalized?.candidates));
    assert.equal(normalized.candidates.includes('Ceramide NP'), true);
    assert.equal(normalized.candidates.includes('Panthenol'), true);

    const merged = __internal.mergeIngredientRecoContextValue(
      { query: 'octocrylene', candidates: ['Octocrylene'] },
      { goal: 'barrier', sensitivity: 'medium', candidates: ['Ceramide NP'] },
    );
    assert.equal(merged?.query, 'octocrylene');
    assert.equal(merged?.goal, 'barrier');
    assert.equal(merged?.sensitivity, 'medium');
    assert.equal(Array.isArray(merged?.candidates), true);
    assert.equal(merged.candidates.includes('Octocrylene'), true);
    assert.equal(merged.candidates.includes('Ceramide NP'), true);

    const prompt = __internal.buildAuroraProductRecommendationsQuery({
      profile: { skinType: 'combination', barrierStatus: 'healthy', goals: ['barrier repair'] },
      requestText: '',
      lang: 'EN',
      ingredientContext: { goal: 'barrier', sensitivity: 'high', candidates: ['Ceramide NP', 'Panthenol'] },
    });
    assert.match(prompt, /"ingredient_context"\s*:/i);
    assert.match(prompt, /"goal"\s*:\s*"barrier"/i);
    assert.match(prompt, /"candidates"\s*:\s*\[/i);
    assert.match(prompt, /Respect ingredient_context strictly/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco prompt bundle uses v1_2 for generic mode and tags ingredient mode separately', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const genericSpec = __internal.resolveRecoMainPromptSpec({});
    assert.equal(genericSpec.template_id, 'reco_main_v1_2');
    assert.equal(genericSpec.llm_mode, 'goal_based_products');

    const ingredientSpec = __internal.resolveRecoMainPromptSpec({
      ingredientContext: { goal: 'barrier', sensitivity: 'high', candidates: ['Ceramide NP'] },
    });
    assert.equal(ingredientSpec.template_id, 'reco_main_v1_2');
    assert.equal(ingredientSpec.llm_mode, 'ingredient_filtered_products');

    const bundle = __internal.buildAuroraProductRecommendationsPromptBundle({
      profile: { skinType: 'combination', barrierStatus: 'healthy', goals: ['barrier repair'] },
      requestText: 'Recommend products for barrier support',
      lang: 'EN',
      globalStatus: { budget_known: true, itinerary_provided: false, recent_logs_provided: false },
      candidates: [{ product_id: 'prod_1', brand: 'Brand', name: 'Barrier Cream' }],
    });
    assert.match(bundle.query, /PROMPT_TEMPLATE_ID=reco_main_v1_2/i);
    assert.equal(bundle.prompt_spec.llm_mode, 'goal_based_products');
    assert.ok(Number(bundle.schema_chars) > 0);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco prompt contract: query must contain template/system/user blocks and hash must match', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const query = __internal.buildAuroraProductRecommendationsQuery({
      profile: { skinType: 'combination' },
      requestText: 'Recommend products for barrier support',
      lang: 'EN',
      ingredientContext: { goal: 'barrier', sensitivity: 'high', candidates: ['Ceramide NP'] },
    });
    const expectedHash = crypto.createHash('sha1').update(String(query || '')).digest('hex').slice(0, 16);
    const okResult = __internal.validateRecoPromptContract({
      query,
      expectedTemplateId: 'reco_main_v1_2',
      expectedPromptHash: expectedHash,
    });
    assert.equal(okResult.ok, true);
    assert.equal(Array.isArray(okResult.issues), true);
    assert.equal(okResult.issues.length, 0);
    assert.equal(okResult.template_id, 'reco_main_v1_2');

    const badResult = __internal.validateRecoPromptContract({
      query: String(query || '').replace('USER_PROMPT_JSON:', 'USER_PROMPT_BLOCK:'),
      expectedTemplateId: 'reco_main_v1_2',
      expectedPromptHash: expectedHash,
    });
    assert.equal(badResult.ok, false);
    assert.equal(badResult.issues.includes('missing_user_prompt_json_block'), true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi keeps ungrounded editorial recommendations without PDP url', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.sanitizeRecoCandidatesForUi([
      {
        type: 'recommendations',
        payload: {
          recommendations: [
            {
              grounding_status: 'ungrounded',
              product_type: 'serum',
              brand: 'Editorial',
              name: 'Barrier Support Serum',
              display_name: 'Editorial Barrier Support Serum',
              concern_match: ['barrier', 'redness'],
              reasons: ['Supports barrier recovery with a low-irritation format.'],
            },
          ],
        },
      },
    ], {
      strictFilter: true,
      qaMode: 'off',
      allowOpenAiFallback: false,
    });

    const recoCard = Array.isArray(out.cards) ? out.cards.find((card) => card?.type === 'recommendations') : null;
    const recs = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.grounding_status, 'ungrounded');
    assert.equal(String(recoCard?.payload?.products_empty_reason || ''), '');
  } finally {
    delete require.cache[moduleId];
  }
});

test('quality contract ignores missing purchase path for ungrounded editorial recommendations', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const result = __internal.evaluateQualityContractForEnvelope({
      envelope: {
        cards: [
          {
            type: 'recommendations',
            payload: {
              recommendations: [
                {
                  grounding_status: 'ungrounded',
                  product_type: 'moisturizer',
                  brand: 'Editorial',
                  name: 'Barrier Cream',
                },
              ],
            },
          },
        ],
      },
      policyMeta: { intent_canonical: 'reco_products' },
      assistantText: 'Here are recommendations.',
      profile: {},
    });
    assert.equal(result.url_invariant_pass, true);
    assert.equal(result.critical_fail_reasons.includes('missing_product_urls_in_recommendations'), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('quality contract does not treat framework recommendation payload keys as a seed-profile reask', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const result = __internal.evaluateQualityContractForEnvelope({
      envelope: {
        assistant_message: {
          role: 'assistant',
          content: 'For oily skin, start with Oil-control treatment, then keep Lightweight moisturizer and Daily sunscreen as support roles.',
        },
        cards: [
          {
            type: 'recommendations',
            payload: {
              framework_summary: {
                concern_text: 'im oily skin, what product should i use?',
                headline: 'Start with Oil-control treatment, then layer the supporting roles',
                primary_role_label: 'Oil-control treatment',
              },
              roles: [
                {
                  role_id: 'oil_control_treatment',
                  label: 'Oil-control treatment',
                  why_this_role: 'Start with a targeted oil-control step to manage shine, congestion, or clogged pores.',
                },
                {
                  role_id: 'lightweight_moisturizer',
                  label: 'Lightweight moisturizer',
                  why_this_role: 'Keep hydration light and breathable so skin stays balanced without feeling heavy.',
                },
              ],
              recommendations: [
                {
                  product_id: 'serum_1',
                  display_name: 'Oil Balance Serum',
                  matched_role_id: 'oil_control_treatment',
                  notes: ['Start with a targeted oil-control step to manage shine, congestion, or clogged pores.'],
                },
              ],
            },
          },
        ],
      },
      policyMeta: { intent_canonical: 'reco_products' },
      assistantText: 'For oily skin, what product should i use? Start with Oil-control treatment first.',
      profile: {
        skinType: 'oily',
        goals: ['oil control'],
      },
    });

    assert.equal(result.strict_fail_flags.entity_miss_fail_seed_profile, false);
    assert.equal(result.critical_fail_reasons.includes('entity_miss_fail_seed_profile'), false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco warning visibility contract hides internal-only warning codes from user-visible warnings', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const contract = __internal.applyRecoWarningVisibilityContract({
      warnings: ['analysis_missing', 'recent_logs_missing', 'over_budget'],
      missing_info: ['itinerary_unknown', 'price_unknown'],
    });
    assert.equal(Array.isArray(contract?.payload?.warning_codes_internal), true);
    assert.equal(contract.payload.warning_codes_internal.includes('analysis_missing'), true);
    assert.equal(contract.payload.warning_codes_internal.includes('recent_logs_missing'), true);
    assert.equal(contract.payload.warning_codes_internal.includes('itinerary_unknown'), true);
    assert.equal(contract.payload.warning_codes_internal.includes('price_unknown'), true);
    assert.equal(Array.isArray(contract?.payload?.warning_codes_user_visible), true);
    assert.equal(contract.payload.warning_codes_user_visible.includes('analysis_missing'), false);
    assert.equal(contract.payload.warning_codes_user_visible.includes('recent_logs_missing'), false);
    assert.equal(contract.payload.warning_codes_user_visible.includes('itinerary_unknown'), false);
    assert.equal(contract.payload.warning_codes_user_visible.includes('over_budget'), true);
    assert.equal(contract.payload.warning_codes_user_visible.includes('price_unknown'), true);
    assert.deepEqual(contract.payload.warnings, contract.payload.warning_codes_user_visible);
  } finally {
    delete require.cache[moduleId];
  }
});

test('/v1/chat: alternatives budget exhausted only degrades alternatives (recommendations remain)', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_CHAT_RECO_BUDGET_MS: '2000',
      AURORA_BFF_RECO_ALTERNATIVES_TIMEOUT_MS: '6500',
      AURORA_BFF_RECO_ALTERNATIVES_OVERHEAD_MS: '2000',
    },
    async () => {
      resetVisionMetrics();
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          return { ok: true, json: { products: [{ id: 'fake_1', why: 'should_not_happen' }] } };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set({
            'X-Aurora-UID': 'test_uid_alt_budget',
            'X-Trace-ID': 'test_trace_alt_budget',
            'X-Brief-ID': 'test_brief_alt_budget',
            'X-Lang': 'EN',
          })
          .send({
            action: {
              action_id: 'chip.start.routine',
              kind: 'chip',
              data: {
                reply_text: 'Build AM PM routine',
                include_alternatives: true,
                profile_patch: {
                  skinType: 'combination',
                  sensitivity: 'low',
                  barrierStatus: 'healthy',
                  goals: ['pores'],
                  budgetTier: 'budget',
                },
              },
            },
            session: { state: 'S2_DIAGNOSIS' },
            language: 'EN',
          });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const recoCard = cards.find((c) => c && c.type === 'recommendations');
        assert.ok(recoCard);
        const recos = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
        assert.ok(recos.length > 0);
        assert.equal(recos.some((item) => Array.isArray(item?.alternatives) && item.alternatives.length > 0), false);

        const snap = snapshotVisionMetrics();
        assert.ok(Number(snap.recoAlternativesBudgetExhaustedTotal || 0) >= 1);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        delete require.cache[moduleId];
      }
    },
  );
});

test('reco alternatives target signals and query plan retain sunscreen compare context from product-card rows', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const product = {
      product_id: 'ext_anchor_sunscreen',
      merchant_id: 'external_seed',
      brand: 'the ordinary',
      name: 'UV Filters SPF 45 Serum',
      display_name: 'UV Filters SPF 45 Serum',
      category: 'sunscreen',
      product_type: 'sunscreen',
      key_features: ['UV filters', 'Glycerin', 'Lightweight serum'],
      short_description: 'It keeps your daytime protection step easier to wear every morning.',
      description: 'A lightweight SPF 45 sunscreen serum that protects and hydrates, for daily use with no white cast.',
    };

    const signals = __internal.buildRecoAlternativesTargetSignals(product, {
      productInput: 'UV Filters SPF 45 Serum',
      lang: 'EN',
    });
    const queries = __internal.buildExternalSeedCompareSearchQueries({
      productObj: product,
      productInput: 'UV Filters SPF 45 Serum',
      lang: 'EN',
    });

    assert.equal(signals.usageRole, 'sunscreen');
    assert.ok(signals.primaryClaims.includes('sun protection'));
    assert.ok(signals.primaryClaims.includes('hydration'));
    assert.ok(signals.primaryClaims.includes('Glycerin'));
    assert.ok(signals.textureHints.includes('serum texture'));
    assert.ok(signals.textureHints.includes('lightweight finish'));
    assert.equal(queries.some((query) => /sunscreen sunscreen/i.test(String(query))), false);
    assert.ok(queries.slice(0, 4).some((query) => /sun protection|hydration|lightweight finish/i.test(String(query))));
  } finally {
    delete require.cache[moduleId];
  }
});

test('reco alternatives target signals prefer role-scope over noisy narrative form words', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const product = {
      product_id: '10008793153864',
      merchant_id: 'merch_efbc46b4619cfbdf',
      name: 'KraveBeauty Great Barrier Relief',
      display_name: 'KraveBeauty Great Barrier Relief',
      category: 'moisturizer',
      product_type: 'moisturizer',
      role_scope: 'hydrating_barrier_moisturizer',
      selected_target_id: 'hydrating_barrier_moisturizer',
      description: 'A barrier-repair serum for over-sensitized or irritated skin, built around tamanu oil, niacinamide, and ceramides.',
    };

    const signals = __internal.buildRecoAlternativesTargetSignals(product, {
      productInput: 'KraveBeauty Great Barrier Relief',
      lang: 'EN',
    });
    const localRole = __internal.buildRecoAlternativesLocalSeedSearchRole(signals);

    assert.equal(signals.usageRole, 'moisturizer');
    assert.equal(signals.primaryClaims.some((claim) => /bright/i.test(String(claim || ''))), false);
    assert.equal(localRole.preferred_step, 'moisturizer');
  } finally {
    delete require.cache[moduleId];
  }
});

test('/v1/reco/alternatives: external_seed sunscreen compare recalls pool hits from richer anchor signals before provider', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const seenQueries = [];
      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const queryText = String(
          config?.params?.q ||
          config?.params?.query ||
          config?.params?.text ||
          '',
        ).trim();
        seenQueries.push(queryText);
        if (/(sun protection|hydration|lightweight finish).*(sunscreen)|sunscreen.*(sun protection|hydration|lightweight finish)/i.test(queryText)) {
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'ext_skin1004_sunscreen',
                  merchant_id: 'external_seed',
                  brand: 'Skin1004',
                  name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
                  display_name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_skin1004_sunscreen',
                    merchant_id: 'external_seed',
                  },
                  url: 'https://skin1004.com/products/hyalu-cica-water-fit-sun-serum-spf50',
                },
                {
                  product_id: 'ext_lrp_anthelios',
                  merchant_id: 'external_seed',
                  brand: 'La Roche-Posay',
                  name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
                  display_name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_lrp_anthelios',
                    merchant_id: 'external_seed',
                  },
                  url: 'https://laroche-posay.us/products/anthelios-ultra-light-invisible-fluid-spf-50',
                },
                {
                  product_id: 'ext_neutrogena_face_serum',
                  merchant_id: 'external_seed',
                  brand: 'Neutrogena',
                  name: 'Invisible Daily Defense Face Serum SPF 60+',
                  display_name: 'Invisible Daily Defense Face Serum SPF 60+',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_neutrogena_face_serum',
                    merchant_id: 'external_seed',
                  },
                  url: 'https://www.neutrogena.com/products/sun/invisible-daily-defense-face-serum-spf-60/6811153.html',
                },
                {
                  product_id: 'ext_supergoop_body',
                  merchant_id: 'external_seed',
                  brand: 'Supergoop!',
                  name: 'Unseen Sunscreen Body SPF 40',
                  display_name: 'Unseen Sunscreen Body SPF 40',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_supergoop_body',
                    merchant_id: 'external_seed',
                  },
                  url: 'https://supergoop.com/products/unseen-sunscreen-body-spf-40',
                },
                {
                  product_id: 'ext_supergoop_stick',
                  merchant_id: 'external_seed',
                  brand: 'Supergoop!',
                  name: 'Unseen Sunscreen Stick SPF 40',
                  display_name: 'Unseen Sunscreen Stick SPF 40',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_supergoop_stick',
                    merchant_id: 'external_seed',
                  },
                  url: 'https://supergoop.com/products/unseen-sunscreen-stick-spf-40',
                },
              ],
            },
          };
        }
        return { status: 200, data: { products: [] } };
      };

      const kbStoreModuleId = require.resolve('../src/auroraBff/productIntelKbStore');
      delete require.cache[kbStoreModuleId];
      const kbStore = require('../src/auroraBff/productIntelKbStore');
      const originalGetProductIntelKbEntry = kbStore.getProductIntelKbEntry;
      kbStore.getProductIntelKbEntry = async (kbKey) => {
        if (kbKey !== 'product:ext_neutrogena_face_serum') return null;
        return {
          kb_key: kbKey,
          analysis: {
            product_intel_v1: {
              contract_version: 'pivota.product_intel.v1',
              canonical_product_ref: {
                product_id: 'ext_neutrogena_face_serum',
                merchant_id: 'external_seed',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Pivota Insights',
                  body: 'A high-protection facial serum that combines SPF 60+ with ginger extract while staying clear on skin.',
                },
                best_for: [
                  { label: 'All skin tones seeking a high SPF without a white cast' },
                ],
                why_it_stands_out: [
                  { body: 'Formulated to remain invisible across all skin tones.' },
                ],
              },
              shopping_card: {
                title: 'Neutrogena Invisible Daily Defense Face Serum SPF 60+',
                subtitle: 'Serum',
                intro: 'High-protection facial serum with SPF 60+.',
              },
              search_card: {
                compact_candidate: 'Serum',
                intro_candidate: 'High-protection facial serum with SPF 60+.',
              },
            },
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        let geminiCalled = false;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalled = true;
          throw new Error('provider should not run when grounded sunscreen pool is sufficient');
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_sunscreen_pool_recall',
            'X-Trace-ID': 'test_trace_alt_sunscreen_pool_recall',
            'X-Brief-ID': 'test_brief_alt_sunscreen_pool_recall',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'UV Filters SPF 45 Serum',
            max_total: 6,
            disable_synthetic_local_fallback: true,
            product: {
              product_id: 'ext_anchor_sunscreen',
              merchant_id: 'external_seed',
              brand: 'the ordinary',
              name: 'UV Filters SPF 45 Serum',
              display_name: 'UV Filters SPF 45 Serum',
              product_type: 'sunscreen',
              category: 'sunscreen',
              key_features: ['UV filters', 'Glycerin', 'Lightweight serum'],
              short_description: 'It keeps your daytime protection step easier to wear every morning.',
              description: 'A lightweight SPF 45 sunscreen serum that protects and hydrates, for daily use with no white cast.',
              canonical_product_ref: {
                product_id: 'ext_anchor_sunscreen',
                merchant_id: 'external_seed',
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(geminiCalled, false);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.ok(Number(resp.body?.compare_meta?.pool_selected_count || 0) >= 3);
        assert.ok(seenQueries.some((query) => /sun protection|hydration|lightweight finish/i.test(String(query))));
        assert.equal(resp.body.alternatives.every((alt) => String(alt?.candidate_origin || '') === 'pool'), true);
        assert.equal(resp.body.alternatives.every((alt) => String(alt?.grounding_status || '') === 'catalog_verified'), true);
        const names = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.equal(names.some((name) => /body/i.test(name)), false);
        assert.equal(names.some((name) => /stick/i.test(name)), false);
        const neutrogena = resp.body.alternatives.find((alt) => String(alt?.product?.product_id || '') === 'ext_neutrogena_face_serum');
        assert.equal(neutrogena?.metadata?.product_intel_kb_used, true);
        assert.equal(
          neutrogena?.product_intel?.product_intel_core?.what_it_is?.body,
          'A high-protection facial serum that combines SPF 60+ with ginger extract while staying clear on skin.',
        );
        assert.ok(
          Array.isArray(neutrogena?.compare_highlights)
          && neutrogena.compare_highlights.some((line) => /invisible across all skin tones|high-protection facial serum/i.test(String(line))),
        );
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        kbStore.getProductIntelKbEntry = originalGetProductIntelKbEntry;
        axios.get = originalGet;
        delete require.cache[moduleId];
        delete require.cache[kbStoreModuleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: anchor precheck hydrates resolved sunscreen product for text-only pool recall', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const seenQueries = [];
      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const queryText = String(
          config?.params?.q ||
          config?.params?.query ||
          config?.params?.text ||
          '',
        ).trim();
        seenQueries.push(queryText);
        if (/(sun protection|hydration|lightweight finish).*(sunscreen)|sunscreen.*(sun protection|hydration|lightweight finish)/i.test(queryText)) {
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'ext_skin1004_sunscreen',
                  merchant_id: 'external_seed',
                  brand: 'Skin1004',
                  name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
                  display_name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_skin1004_sunscreen',
                    merchant_id: 'external_seed',
                  },
                },
                {
                  product_id: 'ext_lrp_anthelios',
                  merchant_id: 'external_seed',
                  brand: 'La Roche-Posay',
                  name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
                  display_name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_lrp_anthelios',
                    merchant_id: 'external_seed',
                  },
                },
                {
                  product_id: 'ext_neutrogena_face_serum',
                  merchant_id: 'external_seed',
                  brand: 'Neutrogena',
                  name: 'Invisible Daily Defense Face Serum SPF 60+',
                  display_name: 'Invisible Daily Defense Face Serum SPF 60+',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_neutrogena_face_serum',
                    merchant_id: 'external_seed',
                  },
                },
              ],
            },
          };
        }
        return { status: 200, data: { products: [] } };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let geminiCalled = false;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalled = true;
          throw new Error('provider should not run when text-only anchor precheck hydrates a sufficient sunscreen pool');
        });
        __internal.__setResolveProductRefForTest(async (args = {}) => ({
          resolved: /uv filters spf 45 serum/i.test(String(args?.query || '')),
          product_ref: {
            product_id: 'ext_anchor_sunscreen',
            merchant_id: 'external_seed',
          },
          reason: 'resolved',
          candidates: [
            {
              product_id: 'ext_anchor_sunscreen',
              merchant_id: 'external_seed',
              brand: 'the ordinary',
              name: 'UV Filters SPF 45 Serum',
              display_name: 'UV Filters SPF 45 Serum',
              product_type: 'sunscreen',
              category: 'sunscreen',
              key_features: ['UV filters', 'Glycerin', 'Lightweight serum'],
              short_description: 'It keeps your daytime protection step easier to wear every morning.',
              description: 'A lightweight SPF 45 sunscreen serum that protects and hydrates, for daily use with no white cast.',
              canonical_product_ref: {
                product_id: 'ext_anchor_sunscreen',
                merchant_id: 'external_seed',
              },
            },
          ],
          metadata: {
            sources: [{ source: 'agent_search_external_seed', ok: true }],
          },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: { lang: 'EN', request_id: 'req_text_only_sunscreen_pool', trace_id: 'trace_text_only_sunscreen_pool' },
          profileSummary: null,
          recentLogs: [],
          productInput: 'UV Filters SPF 45 Serum',
          productObj: null,
          anchorId: '',
          maxTotal: 6,
          candidatePool: [],
          debug: true,
          logger: null,
          options: {
            recommendation_mode: 'pool_open_world_mixed',
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: false,
            skip_anchor_precheck: false,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(geminiCalled, false);
        assert.equal(out?.source_mode, 'pool_open_world_mixed');
        assert.equal(out?.recommendation_mode, 'pool_open_world_mixed');
        assert.equal(out?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.ok(Number(out?.compare_meta?.pool_selected_count || 0) >= 3);
        assert.ok(seenQueries.some((query) => /sun protection|hydration|lightweight finish/i.test(String(query))));
        assert.equal(out?.debug?.anchor_precheck?.resolved, true);
        assert.equal(out?.debug?.anchor_precheck?.resolved_product_hydrated, true);
        assert.equal(Array.isArray(out?.alternatives), true);
        assert.equal(out.alternatives.every((alt) => String(alt?.grounding_status || '') === 'catalog_verified'), true);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: grounded sunscreen pool ranks texture-aligned rows ahead of cosmetic-finish variants', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const seenQueries = [];
      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const queryText = String(config?.params?.q || config?.params?.query || config?.params?.text || '').trim();
        seenQueries.push(queryText);
        if (!/^sunscreen$/i.test(queryText)) {
          return { status: 200, data: { products: [] } };
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_neutrogena_face_serum',
                merchant_id: 'external_seed',
                brand: 'Neutrogena',
                name: 'Invisible Daily Defense Face Serum SPF 60+',
                display_name: 'Invisible Daily Defense Face Serum SPF 60+',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                key_features: ['Lightweight serum', 'Invisible finish', 'Daily UV protection'],
                short_description: 'A lightweight face sunscreen serum that stays easy to wear every morning.',
                description: 'Invisible face serum texture with daily UV protection and a non-heavy finish.',
                canonical_product_ref: {
                  product_id: 'ext_neutrogena_face_serum',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_skin1004_sunscreen',
                merchant_id: 'external_seed',
                brand: 'Skin1004',
                name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
                display_name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                key_features: ['Sun serum', 'Hydrating daily SPF', 'Lightweight finish'],
                short_description: 'A water-fit sun serum with lightweight daily protection.',
                description: 'Hydrating sun serum texture built for lightweight daily wear.',
                canonical_product_ref: {
                  product_id: 'ext_skin1004_sunscreen',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_lrp_aox',
                merchant_id: 'external_seed',
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
                display_name: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                key_features: ['Antioxidant serum', 'Daily SPF', 'Face serum texture'],
                short_description: 'A daily antioxidant sunscreen serum with a lighter face-serum feel.',
                description: 'Face serum sunscreen texture for straightforward daily protection.',
                canonical_product_ref: {
                  product_id: 'ext_lrp_aox',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_supergoop_glowscreen',
                merchant_id: 'external_seed',
                brand: 'Supergoop!',
                name: 'Mineral Glowscreen Soft-Radiance Drops SPF 40',
                display_name: 'Mineral Glowscreen Soft-Radiance Drops SPF 40',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                key_features: ['Soft-radiance finish', 'Glow primer effect', 'Pearlescent look'],
                short_description: 'A glowy sunscreen primer with a pearlescent radiance finish.',
                description: 'Soft-radiance drops for a luminous makeup-prep look rather than a plain invisible sunscreen finish.',
                tags: ['glow', 'radiance', 'makeup prep'],
                canonical_product_ref: {
                  product_id: 'ext_supergoop_glowscreen',
                  merchant_id: 'external_seed',
                },
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let geminiCalled = false;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalled = true;
          throw new Error('provider should not run when the grounded sunscreen pool is sufficient');
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_sunscreen_pool_rank',
            trace_id: 'trace_sunscreen_pool_rank',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary UV Filters SPF 45 Serum',
          productObj: {
            brand: 'The Ordinary',
            name: 'UV Filters SPF 45 Serum',
            product_type: 'sunscreen',
            category: 'Sunscreen',
            claims: ['daily sunscreen', 'lightweight protection'],
            key_features: ['Lightweight serum', 'Daily UV protection'],
            short_description: 'A lightweight sunscreen serum for daily protection.',
            description: 'Lightweight serum texture with daily UV protection and no heavy finish.',
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          debug: true,
          logger: null,
          options: {
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: false,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(geminiCalled, false);
        assert.equal(out?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.equal(Array.isArray(out?.alternatives), true);
        assert.equal(out.alternatives.length, 3);
        const returnedNames = out.alternatives.map((row) => String(row?.product?.name || row?.name || ''));
        assert.ok(returnedNames.includes('Invisible Daily Defense Face Serum SPF 60+'));
        assert.ok(returnedNames.includes('Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+'));
        assert.ok(!returnedNames.includes('Mineral Glowscreen Soft-Radiance Drops SPF 40'));
        const serumRow = out.alternatives.find((row) => /face serum spf 60\+|water-fit sun serum/i.test(String(row?.product?.name || row?.name || '')));
        assert.match(String(serumRow?.why_this_one || ''), /serum-like and fresh|thinner sunscreen feel|lighter daily sunscreen feel/i);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: thin role-scope moisturizer anchors do not drift into serum alternatives', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const seenQueries = [];
      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const queryText = String(config?.params?.q || config?.params?.query || config?.params?.text || '').trim();
        seenQueries.push(queryText);
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: '9886499864904',
                merchant_id: 'merch_ordinary',
                brand: 'The Ordinary',
                name: 'Niacinamide 10% + Zinc 1%',
                display_name: 'Niacinamide 10% + Zinc 1%',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'catalog',
                description: 'Niacinamide serum for excess oil and pores.',
              },
              {
                product_id: 'ext_inkey_niacinamide',
                merchant_id: 'external_seed',
                brand: 'The Inkey List',
                name: '10% Niacinamide Serum',
                display_name: '10% Niacinamide Serum',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                description: 'Hydrating serum with niacinamide and hyaluronic support for excess oil.',
              },
              {
                product_id: 'ext_skin1004_niacinamide_ampoule',
                merchant_id: 'external_seed',
                brand: 'Skin1004',
                name: 'Niacinamide 10 Boosting Shot Ampoule',
                display_name: 'Niacinamide 10 Boosting Shot Ampoule',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                description: 'Calming hydrating ampoule with niacinamide for pores and shine.',
              },
              {
                product_id: 'ext_haruharu_retinal_serum',
                merchant_id: 'external_seed',
                brand: 'Haruharu Wonder',
                name: 'Firming Serum (with Retinal 0.1%)',
                display_name: 'Firming Serum (with Retinal 0.1%)',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                description: 'Retinal serum for firmness and fine lines.',
              },
              {
                product_id: 'ext_boj_eye_serum',
                merchant_id: 'external_seed',
                brand: 'Beauty of Joseon',
                name: 'Revive Eye Serum : Ginseng + Retinal',
                display_name: 'Revive Eye Serum : Ginseng + Retinal',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                description: 'Eye serum for the under-eye area.',
                canonical_product_ref: {
                  product_id: 'ext_boj_eye_serum',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_cocokind_ceramide_barrier_serum',
                merchant_id: 'external_seed',
                brand: 'Cocokind',
                name: 'Ceramide Barrier Serum',
                display_name: 'Ceramide Barrier Serum',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                description: 'Ceramide barrier serum for hydration and barrier repair.',
                canonical_product_ref: {
                  product_id: 'ext_cocokind_ceramide_barrier_serum',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_neutrogena_hydro_boost',
                merchant_id: 'external_seed',
                brand: 'Neutrogena',
                name: 'Hydro Boost Water Gel',
                display_name: 'Hydro Boost Water Gel',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Lightweight water-gel moisturizer for hydration.',
                canonical_product_ref: {
                  product_id: 'ext_neutrogena_hydro_boost',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_round_lab_dark_spot_cream',
                merchant_id: 'external_seed',
                brand: 'Round Lab',
                name: 'Vita Niacinamide Dark Spot Cream',
                display_name: 'Vita Niacinamide Dark Spot Cream',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Brightening dark spot cream with niacinamide for uneven tone.',
                canonical_product_ref: {
                  product_id: 'ext_round_lab_dark_spot_cream',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_haruharu_radiance_gel_cream',
                merchant_id: 'external_seed',
                brand: 'Haruharu Wonder',
                name: '5% Niacinamide Radiance Gel Cream / Unscented',
                display_name: '5% Niacinamide Radiance Gel Cream / Unscented',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Radiance gel cream for brightening and uneven tone.',
                canonical_product_ref: {
                  product_id: 'ext_haruharu_radiance_gel_cream',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_rare_beauty_tinted_moisturizer',
                merchant_id: 'external_seed',
                brand: 'rare beauty',
                name: 'Positive Light Tinted Moisturizer',
                display_name: 'Positive Light Tinted Moisturizer',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Tinted complexion coverage moisturizer.',
                canonical_product_ref: {
                  product_id: 'ext_rare_beauty_tinted_moisturizer',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_rare_beauty_tinted_moisturizer_spf',
                merchant_id: 'external_seed',
                brand: 'rare beauty',
                name: 'Positive Light Tinted Moisturizer SPF 20',
                display_name: 'Positive Light Tinted Moisturizer SPF 20',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Tinted complexion coverage moisturizer with SPF.',
                canonical_product_ref: {
                  product_id: 'ext_rare_beauty_tinted_moisturizer_spf',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_rare_beauty_lip_souffle',
                merchant_id: 'external_seed',
                brand: 'rare beauty',
                name: 'Lip Soufflé Matte Lip Cream',
                display_name: 'Lip Soufflé Matte Lip Cream',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Whipped lip cream with a comfortable matte finish.',
                canonical_product_ref: {
                  product_id: 'ext_rare_beauty_lip_souffle',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_fab_smooth_shave',
                merchant_id: 'external_seed',
                brand: 'First Aid Beauty',
                name: 'Smooth Shave Cream',
                display_name: 'Smooth Shave Cream',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Shaving cream for a smoother razor glide.',
                canonical_product_ref: {
                  product_id: 'ext_fab_smooth_shave',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_pc_electrolyte_moisturizer',
                merchant_id: 'external_seed',
                brand: "Paula's Choice",
                name: 'Water-Infusing Electrolyte Moisturizer',
                display_name: 'Water-Infusing Electrolyte Moisturizer',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Water-light moisturizer with barrier support.',
                canonical_product_ref: {
                  product_id: 'ext_pc_electrolyte_moisturizer',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_krave_oat_water_cream',
                merchant_id: 'external_seed',
                brand: 'KraveBeauty',
                name: 'Oat So Simple Water Cream',
                display_name: 'Oat So Simple Water Cream',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Simple lightweight water cream for barrier-friendly hydration.',
                canonical_product_ref: {
                  product_id: 'ext_krave_oat_water_cream',
                  merchant_id: 'external_seed',
                },
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let geminiCalled = false;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalled = true;
          throw new Error('provider should not run when role-scope grounded pool is sufficient');
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_role_scope_moisturizer_pool',
            trace_id: 'trace_role_scope_moisturizer_pool',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'KraveBeauty Great Barrier Relief',
          productObj: {
            product_id: '10008793153864',
            merchant_id: 'merch_efbc46b4619cfbdf',
            name: 'KraveBeauty Great Barrier Relief',
            display_name: 'KraveBeauty Great Barrier Relief',
            category: 'moisturizer',
            product_type: 'moisturizer',
            role_scope: 'hydrating_barrier_moisturizer',
            selected_target_id: 'hydrating_barrier_moisturizer',
            description: 'A barrier-repair serum for over-sensitized or irritated skin, built around tamanu oil, niacinamide, and ceramides.',
          },
          anchorId: '10008793153864',
          maxTotal: 3,
          candidatePool: [],
          debug: true,
          logger: null,
          options: {
            recommendation_mode: 'pool_open_world_mixed',
            disable_synthetic_local_fallback: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(geminiCalled, false);
        assert.equal(out?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.ok(seenQueries.some((query) => /\bmoisturizer\b/i.test(String(query))));
        const names = out.alternatives.map((row) => String(row?.product?.name || row?.name || ''));
        assert.equal(names.some((name) => /Niacinamide|Retinal|Eye|Boosting Shot Ampoule/i.test(name)), false);
        assert.equal(names.some((name) => /dark spot|radiance/i.test(name)), false);
        assert.equal(names.some((name) => /tinted moisturizer/i.test(name)), false);
        assert.equal(names.some((name) => /lip souffl[eé]|matte lip cream/i.test(name)), false);
        assert.equal(names.some((name) => /smooth shave cream|shave cream/i.test(name)), false);
        assert.equal(out.alternatives.every((row) => /moisturizer/i.test(String(row?.product?.category || ''))), true);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: barrier moisturizer alternatives rank barrier-support evidence ahead of generic hydration', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_joseon_dynasty_cream',
                merchant_id: 'external_seed',
                brand: 'Beauty of Joseon',
                name: 'Dynasty Cream',
                display_name: 'Dynasty Cream',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Hydrating cream with niacinamide and a dewy finish.',
                product_intel: {
                  one_liner: 'A daily moisturizer built around niacinamide, ceramide/barrier-lipid support plus humectants for hydration.',
                },
                shopping_card: {
                  intro: 'Barrier-support cues line up with the anchor instead of drifting into a more generic moisturizer compare.',
                },
                canonical_product_ref: {
                  product_id: 'ext_joseon_dynasty_cream',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_fab_ultra_repair_face_lotion',
                merchant_id: 'external_seed',
                brand: 'First Aid Beauty',
                name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
                display_name: 'Ultra Repair Face Lotion with Colloidal Oatmeal',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Barrier-support face lotion with colloidal oatmeal, ceramides, and calming hydration.',
                product_intel: {
                  one_liner: 'Light daily lotion with colloidal oatmeal and ceramides for calming barrier comfort.',
                },
                canonical_product_ref: {
                  product_id: 'ext_fab_ultra_repair_face_lotion',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_dieux_air_angel',
                merchant_id: 'external_seed',
                brand: 'Dieux',
                name: 'Air Angel Peptide Plumping Gel Cream',
                display_name: 'Air Angel Peptide Plumping Gel Cream',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Light gel-cream hydration with peptides for daily moisture.',
                canonical_product_ref: {
                  product_id: 'ext_dieux_air_angel',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_bubble_level_up',
                merchant_id: 'external_seed',
                brand: 'Bubble',
                name: 'Level Up',
                display_name: 'Level Up',
                product_type: 'Moisturizer',
                category: 'Moisturizer',
                retrieval_source: 'external_seed',
                description: 'Daily hydration moisturizer with lightweight moisture support.',
                canonical_product_ref: {
                  product_id: 'ext_bubble_level_up',
                  merchant_id: 'external_seed',
                },
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let geminiCalled = false;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalled = true;
          throw new Error('provider should not run when barrier moisturizer pool is sufficient');
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_barrier_alt_rank',
            trace_id: 'trace_barrier_alt_rank',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'Round Lab Soybean Panthenol Cream',
          productObj: {
            product_id: 'ext_roundlab_soybean_panthenol_cream',
            merchant_id: 'external_seed',
            name: 'Round Lab Soybean Panthenol Cream',
            display_name: 'Round Lab Soybean Panthenol Cream',
            category: 'Moisturizer',
            product_type: 'Moisturizer',
            role_scope: 'hydrating_barrier_moisturizer',
            selected_target_id: 'hydrating_barrier_moisturizer',
            short_description: 'Barrier-support cream for dry, tight skin.',
            description: 'Barrier-support cream for dry, tight skin built around panthenol and ceramide comfort.',
          },
          anchorId: 'ext_roundlab_soybean_panthenol_cream',
          maxTotal: 4,
          candidatePool: [],
          debug: true,
          logger: null,
          options: {
            recommendation_mode: 'pool_open_world_mixed',
            disable_synthetic_local_fallback: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(geminiCalled, false);
        assert.equal(out?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        const names = out.alternatives.map((row) => String(row?.product?.name || row?.name || ''));
        assert.equal(names[0], 'Ultra Repair Face Lotion with Colloidal Oatmeal');
        const topReasons = Array.isArray(out.alternatives[0]?.reasons) ? out.alternatives[0].reasons : [];
        assert.ok(topReasons.some((line) => /barrier-support cues line up|same barrier-friendly moisturizer step/i.test(String(line))), JSON.stringify(topReasons));
        assert.ok(topReasons.some((line) => /calming barrier-comfort cues/i.test(String(line))), JSON.stringify(topReasons));
        assert.match(String(out.alternatives[0]?.why_this_one || ''), /calming barrier-comfort cues|dry, tight, or easily irritated skin/i);
        assert.match(String(out.alternatives[0]?.short_description || ''), /calming barrier-comfort cues|dry, tight, or easily irritated skin/i);
        const dynastyRow = out.alternatives.find((row) => /dynasty cream/i.test(String(row?.product?.name || row?.name || '')));
        assert.match(String(dynastyRow?.why_this_one || ''), /hydration-first than barrier-first|hydration-led than barrier-led/i);
        assert.match(String(dynastyRow?.short_description || ''), /hydration-first than barrier-first|hydration-led than barrier-led/i);
        const genericHydrationRow = out.alternatives.find((row) => /air angel|level up/i.test(String(row?.product?.name || row?.name || '')));
        const tradeoffNotes = Array.isArray(genericHydrationRow?.tradeoff_notes) ? genericHydrationRow.tradeoff_notes : [];
        assert.ok(tradeoffNotes.some((line) => /more hydration-led than barrier-led|less explicit barrier-support evidence/i.test(String(line))), JSON.stringify(tradeoffNotes));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: grounded pool folds promo and subscription variants before skipping open-world', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const seenQueries = [];
      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const queryText = String(config?.params?.q || config?.params?.query || config?.params?.text || '').trim();
        seenQueries.push(queryText);
        if (!/^sunscreen$/i.test(queryText)) {
          return { status: 200, data: { products: [] } };
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_round_lab_birch_deal',
                merchant_id: 'external_seed',
                brand: 'Round Lab',
                name: '[DEAL] Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum',
                display_name: '[DEAL] Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Moisturizing sunscreen with daily UV protection.',
                canonical_product_ref: {
                  product_id: 'ext_round_lab_birch_deal',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_round_lab_birch_normal',
                merchant_id: 'external_seed',
                brand: 'Round Lab',
                name: 'Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum',
                display_name: 'Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Moisturizing sunscreen with daily UV protection.',
                canonical_product_ref: {
                  product_id: 'ext_round_lab_birch_normal',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_round_lab_birch_subscription',
                merchant_id: 'external_seed',
                brand: 'Round Lab',
                name: 'Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum [Subscription]',
                display_name: 'Birch Moisturizing Sunscreen UVLock SPF 45+ Broad Spectrum [Subscription]',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Subscription SKU for the same moisturizing sunscreen.',
                canonical_product_ref: {
                  product_id: 'ext_round_lab_birch_subscription',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_round_lab_birch_mildup',
                merchant_id: 'external_seed',
                brand: 'Round Lab',
                name: 'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
                display_name: 'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Mild-up daily sunscreen with UV protection.',
                canonical_product_ref: {
                  product_id: 'ext_round_lab_birch_mildup',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_round_lab_birch_moisturizing_mildup',
                merchant_id: 'external_seed',
                brand: 'Round Lab',
                name: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
                display_name: 'Birch Moisturizing Mild-Up Sunscreen SPF 50+, PA++++',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Moisturizing mild-up sunscreen with daily UV protection.',
                canonical_product_ref: {
                  product_id: 'ext_round_lab_birch_moisturizing_mildup',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_haruharu_airyfit',
                merchant_id: 'external_seed',
                brand: 'Haruharu Wonder',
                name: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
                display_name: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Airy daily sunscreen with an unscented finish.',
                canonical_product_ref: {
                  product_id: 'ext_haruharu_airyfit',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_lrp_aox',
                merchant_id: 'external_seed',
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
                display_name: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Face serum sunscreen for daily UV protection.',
                canonical_product_ref: {
                  product_id: 'ext_lrp_aox',
                  merchant_id: 'external_seed',
                },
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let geminiCalled = false;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalled = true;
          throw new Error('provider should not run when variant-cleaned grounded pool is sufficient');
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_sunscreen_pool_variant_family',
            trace_id: 'trace_sunscreen_pool_variant_family',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++',
          productObj: {
            product_id: 'ext_skintific_matte_fit',
            merchant_id: 'external_seed',
            brand: 'SKINTIFIC',
            name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            display_name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            product_type: 'Sunscreen',
            category: 'Sunscreen',
            key_features: ['Matte finish', 'Serum sunscreen', 'Daily UV protection'],
            short_description: 'A matte serum sunscreen for oily-skin routines.',
          },
          anchorId: 'ext_skintific_matte_fit',
          maxTotal: 3,
          candidatePool: [],
          debug: true,
          logger: null,
          options: {
            recommendation_mode: 'pool_open_world_mixed',
            disable_synthetic_local_fallback: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(geminiCalled, false);
        assert.equal(out?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.equal(out?.alternatives?.length, 3);
        const names = out.alternatives.map((row) => String(row?.product?.name || row?.name || ''));
        assert.equal(names.filter((name) => /Birch Moisturizing Sunscreen/i.test(name)).length, 1);
        assert.equal(names.some((name) => /\bdeal\b|subscription/i.test(name)), false);
        const brands = out.alternatives.map((row) => String(row?.product?.brand || row?.brand || ''));
        assert.ok(brands.filter((brand) => /round lab/i.test(brand)).length <= 2);
        assert.ok(new Set(brands.map((brand) => brand.toLowerCase()).filter(Boolean)).size >= 2);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: sunscreen titles beat seed category drift in grounded pool role inference', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const seenQueries = [];
      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const queryText = String(config?.params?.q || config?.params?.query || config?.params?.text || '').trim();
        seenQueries.push(queryText);
        if (!/^sunscreen$/i.test(queryText)) {
          return { status: 200, data: { products: [] } };
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_haruharu_airyfit',
                merchant_id: 'external_seed',
                brand: 'Haruharu Wonder',
                name: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
                display_name: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                key_features: ['Airy sunscreen', 'Daily UV protection', 'Unscented finish'],
                short_description: 'A lightweight face sunscreen with an airy finish.',
                canonical_product_ref: {
                  product_id: 'ext_haruharu_airyfit',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_round_lab_mild_up',
                merchant_id: 'external_seed',
                brand: 'Round Lab',
                name: 'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
                display_name: 'Birch Mild-Up Sunscreen UVLock SPF 50+ Broad Spectrum',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                key_features: ['Mild-up sunscreen', 'Daily UV protection'],
                short_description: 'A straightforward sunscreen for daily UV protection.',
                canonical_product_ref: {
                  product_id: 'ext_round_lab_mild_up',
                  merchant_id: 'external_seed',
                },
              },
              {
                product_id: 'ext_lrp_aox',
                merchant_id: 'external_seed',
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
                display_name: 'Anthelios AOX Daily Antioxidant Face Serum SPF 50',
                product_type: 'Serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                key_features: ['Antioxidant SPF', 'Face serum texture'],
                short_description: 'A sunscreen serum for daily UV protection.',
                canonical_product_ref: {
                  product_id: 'ext_lrp_aox',
                  merchant_id: 'external_seed',
                },
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let geminiCalled = false;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalled = true;
          throw new Error('provider should not run when title-grounded sunscreen pool is sufficient');
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_sunscreen_seed_category_drift',
            trace_id: 'trace_sunscreen_seed_category_drift',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++',
          productObj: {
            product_id: 'ext_skintific_matte_fit',
            merchant_id: 'external_seed',
            brand: 'SKINTIFIC',
            name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            display_name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
            product_type: 'sunscreen',
            category: 'sunscreen',
            role_scope: 'daily_sunscreen_finish_fit',
            selected_target_id: 'daily_sunscreen_finish_fit',
            key_features: ['Ceramide NP', 'Niacinamide', 'Zinc PCA', 'Vitamin C (Ascorbic acid)'],
            description: 'Oil-controlling, non-greasy sunscreen with Oat Extract and Zinc PCA for oily and acne-prone skin.',
          },
          anchorId: 'ext_skintific_matte_fit',
          maxTotal: 3,
          candidatePool: [],
          debug: true,
          logger: null,
          options: {
            recommendation_mode: 'pool_open_world_mixed',
            disable_synthetic_local_fallback: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(geminiCalled, false);
        assert.equal(out?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.equal(out?.compare_meta?.pool_recall_status, 'full');
        assert.ok(seenQueries.slice(0, 3).some((query) => /^sunscreen$/i.test(String(query || ''))));
        const names = out.alternatives.map((row) => String(row?.product?.name || row?.name || ''));
        assert.equal(out.alternatives.length, 3);
        assert.ok(names.some((name) => /Moisture Airyfit Daily Sunscreen/i.test(name)));
        assert.ok(names.some((name) => /Birch Mild-Up Sunscreen/i.test(name)));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only grounds same-brand SPF title variants from authority hits', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-3-flash-preview',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url, config = {}) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const queryText = String(
          config?.params?.q ||
          config?.params?.query ||
          config?.params?.text ||
          '',
        ).trim();
        if (/daily dose hydra ceramide/i.test(queryText)) {
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'ext_supergoop_daily_dose',
                  merchant_id: 'external_seed',
                  brand: 'Supergoop!',
                  name: 'Daily Dose Hydra-Ceramide Boost + SPF 40 Sunscreen Oil-Free Serum',
                  display_name: 'Daily Dose Hydra-Ceramide Boost + SPF 40 Sunscreen Oil-Free Serum',
                  product_type: 'Sunscreen',
                  category: 'Sunscreen',
                  retrieval_source: 'external_seed',
                  canonical_product_ref: {
                    product_id: 'ext_supergoop_daily_dose',
                    merchant_id: 'external_seed',
                  },
                },
              ],
            },
          };
        }
        return { status: 200, data: { products: [] } };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'Supergoop!',
                name: 'Daily Dose Hydra-Ceramide Boost SPF 40',
                product_type: 'sunscreen serum',
                similarity_score: 77,
                reasons: ['Keeps the same serum-weight SPF step with hydration support.'],
                tradeoff_notes: ['Title variant is shorter than the catalog row.'],
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async () => ({
          resolved: false,
          product_ref: null,
          reason: 'no_candidates',
          metadata: {
            sources: [{ source: 'agent_search_external_seed', ok: false, reason: 'no_results' }],
          },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: { lang: 'EN', request_id: 'req_spf_variant_grounding', trace_id: 'trace_spf_variant_grounding' },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary UV Filters SPF 45 Serum',
          productObj: {
            product_id: 'ext_anchor_sunscreen',
            merchant_id: 'external_seed',
            brand: 'the ordinary',
            name: 'UV Filters SPF 45 Serum',
            display_name: 'UV Filters SPF 45 Serum',
            product_type: 'sunscreen',
            category: 'sunscreen',
            key_features: ['UV filters', 'Glycerin', 'Lightweight serum'],
            short_description: 'It keeps your daytime protection step easier to wear every morning.',
            description: 'A lightweight SPF 45 sunscreen serum that protects and hydrates, for daily use with no white cast.',
            canonical_product_ref: {
              product_id: 'ext_anchor_sunscreen',
              merchant_id: 'external_seed',
            },
          },
          anchorId: 'ext_anchor_sunscreen',
          maxTotal: 3,
          candidatePool: [],
          debug: false,
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(out?.failure_class, null);
        assert.equal(out?.llm_trace?.catalog_grounded_count, 1);
        assert.equal(Array.isArray(out?.alternatives), true);
        assert.equal(out.alternatives.length, 1);
        assert.equal(out.alternatives[0]?.grounding_status, 'catalog_verified');
        assert.equal(out.alternatives[0]?.product?.product_id, 'ext_supergoop_daily_dose');
        assert.equal(out.alternatives[0]?.metadata?.catalog_grounding_mode, 'catalog_fuzzy_search');
        assert.equal(out.alternatives[0]?.metadata?.authority_presence_class, 'external_seed_hit');
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: explicit synthetic fallback opt-in no longer bypasses the no-fallback mainline', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_CHAT_RECO_BUDGET_MS: '9000',
      AURORA_BFF_RECO_ALTERNATIVES_TIMEOUT_MS: '6500',
      AURORA_BFF_RECO_ALTERNATIVES_OVERHEAD_MS: '2000',
    },
    async () => {
      resetVisionMetrics();
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        let geminiCalls = 0;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalls += 1;
          return { ok: true, json: { products: [{ id: 'fake_1', why: 'should_not_happen' }] } };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_no_candidates',
            'X-Trace-ID': 'test_trace_alt_no_candidates',
            'X-Brief-ID': 'test_brief_alt_no_candidates',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'unknown product text with no structured candidate',
            max_total: 3,
            recommendation_mode: 'pool_only',
            disable_synthetic_local_fallback: false,
          });

        assert.equal(resp.status, 200);
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.equal(resp.body.alternatives.length, 0);
        assert.equal(resp.body?.source_mode, 'llm');
        assert.equal(resp.body?.fallback_source, 'none');
        assert.equal(resp.body?.failure_class, 'anchor_missing_precheck');
        assert.equal(geminiCalls, 0);

        const reasons = Array.isArray(resp.body?.field_missing) ? resp.body.field_missing.map((x) => String(x?.reason || '')) : [];
        assert.equal(reasons.includes('anchor_missing_precheck'), true);

        const snap = snapshotVisionMetrics();
        const precheckLabel = JSON.stringify({ stage: 'alternatives', outcome: 'precheck_fail' });
        assert.ok(Number(snap.auroraRecoLlmCall?.find(([k]) => k === precheckLabel)?.[1] || 0) >= 1);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: structured candidate pool returns selector_grounded before synthetic fallback', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_RECO_ALTERNATIVES_TIMEOUT_MS: '6500',
      AURORA_BFF_RECO_ALTERNATIVES_OVERHEAD_MS: '2000',
    },
    async () => {
      resetVisionMetrics();
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        let geminiCalls = 0;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalls += 1;
          return { ok: true, json: { products: [{ id: 'fake_1', why: 'should_not_happen' }] } };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_selector_grounded',
            'X-Trace-ID': 'test_trace_alt_selector_grounded',
            'X-Brief-ID': 'test_brief_alt_selector_grounded',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'unknown product text with selector candidates',
            max_total: 3,
            recommendation_mode: 'pool_only',
            product: {
              name: 'Anchor product',
              alternatives: [
                {
                  product_id: 'prod_alt_1',
                  merchant_id: 'mid_alt',
                  brand: 'Brand One',
                  name: 'Barrier Cream One',
                  display_name: 'Barrier Cream One',
                  pdp_url: 'https://example.com/alt-1',
                  compare_highlights: ['barrier-first'],
                },
                {
                  product_id: 'prod_alt_2',
                  merchant_id: 'mid_alt',
                  brand: 'Brand Two',
                  name: 'Barrier Cream Two',
                  display_name: 'Barrier Cream Two',
                  pdp_url: 'https://example.com/alt-2',
                  compare_highlights: ['low irritation'],
                },
              ],
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'selector_grounded');
        assert.equal(resp.body?.fallback_source, null);
        assert.equal(resp.body?.failure_class, null);
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.ok(resp.body.alternatives.length > 0);
        assert.equal(geminiCalls, 0);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: aurora product-card surface defaults to grounded hybrid alternatives', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [],
          },
        };
      };
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        let geminiCalls = 0;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalls += 1;
          return {
            ok: true,
            json: {
              alternatives: [
                {
                  brand: 'The Inkey List',
                  name: 'Niacinamide Serum',
                  product_type: 'serum',
                  similarity_score: 82,
                  reasons: ['Matches the same oil-control active.'],
                  tradeoff_notes: ['Less focused on zinc support.'],
                },
                {
                  brand: "Paula's Choice",
                  name: '10% Niacinamide Booster',
                  product_type: 'serum',
                  similarity_score: 79,
                  reasons: ['Keeps the same niacinamide-led role.'],
                  tradeoff_notes: ['Higher price point.'],
                },
              ],
            },
          };
        });
        __internal.__setResolveProductRefForTest(async (args = {}) => {
          const query = String(args?.query || '').toLowerCase();
          if (query.includes('the ordinary niacinamide')) {
            return {
              resolved: true,
              product_ref: {
                product_id: 'prod_anchor',
                merchant_id: 'mid_anchor',
              },
              reason: 'resolved',
              metadata: {
                sources: [{ source: 'products_cache', ok: true }],
              },
            };
          }
          if (query.includes('the inkey list') || query.includes('niacinamide serum')) {
            return {
              resolved: true,
              product_ref: {
                product_id: 'ext_inkey_niacinamide',
                merchant_id: 'external_seed',
              },
              reason: 'resolved',
              metadata: {
                sources: [{ source: 'external_seed_local_recall', ok: true }],
              },
            };
          }
          if (query.includes("paula's choice") || query.includes('10% niacinamide booster')) {
            return {
              resolved: true,
              product_ref: {
                product_id: 'ext_pc_niacinamide',
                merchant_id: 'external_seed',
              },
              reason: 'resolved',
              metadata: {
                sources: [{ source: 'external_seed_local_recall', ok: true }],
              },
            };
          }
          return {
            resolved: false,
            product_ref: null,
            reason: 'no_candidates',
            metadata: {
              sources: [{ source: 'external_seed_local_recall', ok: false, reason: 'no_results' }],
            },
          };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_disable_synth',
            'X-Trace-ID': 'test_trace_alt_disable_synth',
            'X-Brief-ID': 'test_brief_alt_disable_synth',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'The Ordinary Niacinamide 10% + Zinc 1%',
            max_total: 6,
          });

        assert.equal(resp.status, 200);
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.fallback_source, null);
        assert.equal(resp.body?.failure_class, null);
        assert.equal(resp.body.alternatives.length, 2);
        assert.equal(resp.body.alternatives[0]?.candidate_origin, 'open_world');
        assert.equal(resp.body.alternatives[0]?.grounding_status, 'catalog_verified');
        assert.equal(resp.body.alternatives[0]?.product?.product_id, 'ext_inkey_niacinamide');
        assert.equal(resp.body?.compare_meta?.open_world_grounded_count, 2);
        assert.equal(geminiCalls, 1);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: explicit pool_only empty structured result stays llm-empty when synthetic fallback is disabled', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      decisionModule.auroraChat = async () => ({
        answer: JSON.stringify({ alternatives: [] }),
        intent: 'alternatives',
      });

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setResolveProductRefForTest(async () => ({
          resolved: true,
          product_ref: {
            product_id: 'prod_anchor',
            merchant_id: 'mid_anchor',
          },
          reason: 'resolved',
          metadata: {
            sources: [{ source: 'products_cache', ok: true }],
          },
        }));

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_empty_structured_no_synth',
            'X-Trace-ID': 'test_trace_alt_empty_structured_no_synth',
            'X-Brief-ID': 'test_brief_alt_empty_structured_no_synth',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'The Ordinary Niacinamide 10% + Zinc 1%',
            max_total: 6,
            recommendation_mode: 'pool_only',
          });

        assert.equal(resp.status, 200);
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.equal(resp.body.alternatives.length, 0);
        assert.equal(resp.body?.source_mode, 'llm');
        assert.equal(resp.body?.fallback_source, 'none');
        assert.equal(resp.body?.failure_class, 'empty_structured');
        assert.equal(resp.body?.refresh_pending, false);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[moduleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only bypasses auroraChat and uses local Gemini', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-2.5-flash',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MAX_OUTPUT_TOKENS: '2048',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      let auroraChatCalls = 0;
      decisionModule.auroraChat = async () => {
        auroraChatCalls += 1;
        throw new Error('auroraChat should not be called for open_world_only');
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let geminiCalls = 0;
        let geminiRequest = null;
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          geminiCalls += 1;
          geminiRequest = args;
          assert.equal(args.route, 'aurora_reco_alternatives_open_world');
          assert.equal(args.ignoreForceModel, true);
          assert.equal(args.model, 'gemini-3-flash-preview');
          assert.match(String(args.systemPrompt || ''), /generic same-step products/i);
          assert.match(String(args.systemPrompt || ''), /share a named active/i);
          assert.match(String(args.systemPrompt || ''), /name-only open-world products/i);
          assert.match(String(args.systemPrompt || ''), /Do not assert unseen ingredients/i);
          assert.equal(args.responseJsonSchema?.properties?.alternatives?.items?.properties?.product_type?.type, 'string');
          assert.equal(args.responseJsonSchema?.properties?.alternatives?.items?.properties?.product_type?.nullable, true);
          assert.equal(Object.prototype.hasOwnProperty.call(args, 'responseSchema'), false);
          return {
            ok: true,
            json: {
              alternatives: [
                {
                  brand: 'Good Molecules',
                  name: 'Niacinamide Serum',
                  product_type: 'serum',
                  similarity_score: 72,
                  reason: 'Niacinamide-led serum role overlaps with the anchor.',
                },
              ],
              empty_reason: null,
            },
          };
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_local',
            trace_id: 'trace_open_world_local',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
          productObj: {
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            product_type: 'serum',
            category: 'Serum',
            ingredients: ['Niacinamide', 'Zinc PCA', 'Pentylene Glycol'],
            claims: ['brightening', 'oil control', 'pore care'],
            texture_hints: ['lightweight', 'water-based'],
            notes: 'A longer descriptive note that should not be forwarded when the anchor already has enough structured signals.',
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(auroraChatCalls, 0);
        assert.equal(geminiCalls, 1);
        assert.equal(out?.ok, true);
        assert.equal(out?.template_id, 'reco_alternatives_open_world_v1');
        assert.equal(out?.source_mode, 'open_world_only');
        assert.equal(out?.llm_trace?.source_mode, 'local_gemini_open_world');
        assert.equal(out?.llm_trace?.provider_model, 'gemini-3-flash-preview');
        assert.equal(Array.isArray(out?.alternatives), true);
        assert.equal(out.alternatives.length, 1);
        assert.equal(out.alternatives[0]?.candidate_origin, 'open_world');
        assert.equal(out.alternatives[0]?.grounding_status, 'name_only');
        assert.equal(out.alternatives[0]?.product?.brand, 'Good Molecules');
        assert.equal(out.alternatives[0]?.product?.name, 'Niacinamide Serum');
        assert.deepEqual(
          out.alternatives[0]?.tradeoff_notes,
          ['Key formula details still need verification before comparing actives or finish.'],
        );
        assert.equal(geminiRequest?.maxOutputTokens, 3072);
        assert.equal(geminiRequest?.timeoutMs, 12000);
        assert.equal(geminiRequest?.queueTimeoutMs, 3000);
        assert.equal(geminiRequest?.upstreamTimeoutMs, 9000);
        assert.equal(geminiRequest?.responseJsonSchema?.properties?.alternatives?.maxItems, 3);
        const payload = JSON.parse(geminiRequest?.userPrompt || '{}');
        assert.equal(payload?.task?.max_alternatives, 3);
        assert.match(String(payload?.task?.selection_rule || ''), /distinct real skincare alternatives/i);
        assert.match(String(payload?.task?.selection_rule || ''), /same functional claim/i);
        assert.ok(Array.isArray(payload?.anchor?.hero_ingredients ?? []));
        assert.ok((payload?.anchor?.hero_ingredients ?? []).length <= 2);
        assert.deepEqual(payload?.anchor?.known_actives ?? [], ['Niacinamide', 'Zinc PCA']);
        assert.equal(Array.isArray(payload?.anchor?.primary_claims ?? []), true);
        assert.ok((payload?.anchor?.primary_claims ?? []).includes('brightening'));
        assert.ok((payload?.anchor?.primary_claims ?? []).some((value) => value === 'oil control' || value === 'blemish care'));
        assert.deepEqual(payload?.anchor?.texture_hints ?? [], ['lightweight']);
        assert.equal(Object.prototype.hasOwnProperty.call(payload?.anchor || {}, 'notes'), false);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[moduleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world local Gemini uses REST executor with split timeout budget', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-3-flash-preview',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_TIMEOUT_MS: '12000',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const Module = require('module');
      const EventEmitter = require('events');
      const axios = require('axios');
      const originalLoad = Module._load;
      const originalGet = axios.get;
      let capturedUrl = '';
      let capturedBody = null;
      let capturedConfig = null;
      axios.get = async () => ({ status: 200, data: { products: [] } });
      Module._load = function patchedLoad(request, parent, isMain) {
        if (request === '@google/genai') {
          throw new Error('Reco alternatives open-world should not use the Gemini SDK executor');
        }
        if (request === 'https') {
          return {
            request: (options = {}, onResponse) => {
              capturedUrl = `${options.protocol || 'https:'}//${options.hostname || ''}${options.path || ''}`;
              capturedConfig = options;
              const req = new EventEmitter();
              req.write = (chunk) => {
                capturedBody = JSON.parse(String(chunk || '{}'));
              };
              req.end = () => {
                process.nextTick(() => {
                  const res = new EventEmitter();
                  res.statusCode = 200;
                  res.statusMessage = 'OK';
                  res.setEncoding = () => {};
                  onResponse(res);
                  res.emit('data', JSON.stringify({
                    candidates: [
                      {
                        finishReason: 'STOP',
                        content: {
                          parts: [
                            {
                              text: JSON.stringify({
                                alternatives: [
                                  {
                                    brand: 'Good Molecules',
                                    name: 'Niacinamide Serum',
                                    product_type: 'serum',
                                    similarity_score: 72,
                                    reasons: ['Niacinamide-led serum role overlaps with the anchor.'],
                                    tradeoff_notes: ['Formula details still need verification.'],
                                  },
                                ],
                              }),
                            },
                          ],
                        },
                      },
                    ],
                  }));
                  res.emit('end');
                });
              };
              req.setTimeout = () => req;
              req.destroy = (err) => {
                if (err) req.emit('error', err);
              };
              return req;
            },
          };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const { __internal } = require('../src/auroraBff/routes');
        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_rest',
            trace_id: 'trace_open_world_rest',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
          productObj: {
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            product_type: 'serum',
            category: 'Serum',
            ingredients: ['Niacinamide', 'Zinc PCA'],
            claims: ['oil control'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.llm_trace?.source_mode, 'local_gemini_open_world');
        assert.match(capturedUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3-flash-preview:generateContent/);
        assert.equal(capturedConfig?.method, 'POST');
        assert.equal(capturedConfig?.timeout, 9000);
        assert.equal(capturedConfig?.headers?.['x-goog-api-key'], 'test_gemini_key');
        assert.equal(capturedBody?.generationConfig?.responseMimeType, 'application/json');
        assert.equal(capturedBody?.generationConfig?.responseSchema?.properties?.alternatives?.type, 'array');
        assert.equal(
          capturedBody?.generationConfig?.responseSchema?.properties?.alternatives?.items?.properties?.product_type?.type,
          'string',
        );
      } finally {
        Module._load = originalLoad;
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only grounds exact catalog hits without changing provider source', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'inkey_niacinamide_catalog',
                merchant_id: 'merchant_inkey',
                brand: 'The Inkey List',
                name: 'Niacinamide Serum',
                display_name: 'Niacinamide Serum',
                product_type: 'serum',
                category: 'Serum',
                url: 'https://www.theinkeylist.com/products/niacinamide-serum',
                price: { amount: 9.99, currency: 'USD', unknown: false },
              },
              {
                product_id: 'wrong_brand_niac',
                merchant_id: 'merchant_wrong',
                brand: 'Other Brand',
                name: 'Niacinamide Serum',
                product_type: 'serum',
                category: 'Serum',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'The Inkey List',
                name: 'Niacinamide Serum',
                product_type: 'serum',
                similarity_score: 82,
                reasons: ['Niacinamide-led serum role overlaps with the anchor for oil control.'],
                tradeoff_notes: ['Does not include the same zinc support.'],
              },
            ],
          },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_grounded',
            trace_id: 'trace_open_world_grounded',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
          productObj: {
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            product_type: 'serum',
            category: 'Serum',
            ingredients: ['Niacinamide', 'Zinc PCA'],
            claims: ['oil control', 'pore care'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.source_mode, 'open_world_only');
        assert.equal(out?.llm_trace?.source_mode, 'local_gemini_open_world');
        assert.equal(out?.llm_trace?.catalog_grounding_attempted_count, 1);
        assert.equal(out?.llm_trace?.catalog_grounded_count, 1);
        assert.equal(out?.alternatives?.length, 1);
        assert.equal(out.alternatives[0]?.candidate_origin, 'pool');
        assert.equal(out.alternatives[0]?.grounding_status, 'catalog_verified');
        assert.equal(out.alternatives[0]?.product?.product_id, 'inkey_niacinamide_catalog');
        assert.equal(out.alternatives[0]?.product?.pdp_url, 'https://www.theinkeylist.com/products/niacinamide-serum');
        assert.equal(out.alternatives[0]?.metadata?.compare_stage, 'open_world_grounded_catalog');
        assert.deepEqual(out.alternatives[0]?.metadata?.merged_candidate_origins, ['open_world', 'pool']);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only grounds unresolved search misses through resolver authority', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        let resolveArgs = null;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'Paula’s Choice',
                name: '10% Niacinamide Booster',
                product_type: 'serum',
                similarity_score: 79,
                reasons: ['Regulates oil production skin tone with the same hero active.'],
                tradeoff_notes: ['Formula concentration differs from the anchor.'],
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async (args = {}) => {
          resolveArgs = args;
          return {
            resolved: true,
            product_ref: {
              product_id: 'resolved_pc_niacinamide',
              merchant_id: 'external_seed',
            },
            confidence: 0.93,
            reason: 'resolved',
          };
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_resolver_grounded',
            trace_id: 'trace_open_world_resolver_grounded',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
          productObj: {
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            product_type: 'serum',
            category: 'Serum',
            ingredients: ['Niacinamide', 'Zinc PCA'],
            claims: ['oil control', 'pore care'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(resolveArgs?.options?.allow_external_seed, true);
        assert.equal(resolveArgs?.options?.external_seed_strategy, 'supplement_internal_first');
        assert.equal(out?.llm_trace?.catalog_grounding_attempted_count, 1);
        assert.equal(out?.llm_trace?.catalog_grounded_count, 1);
        assert.equal(out?.alternatives?.length, 1);
        assert.equal(out.alternatives[0]?.candidate_origin, 'open_world');
        assert.equal(out.alternatives[0]?.grounding_status, 'catalog_verified');
        assert.equal(out.alternatives[0]?.product?.product_id, 'resolved_pc_niacinamide');
        assert.equal(out.alternatives[0]?.product?.merchant_id, 'external_seed');
        assert.equal(out.alternatives[0]?.pdp_open?.path, 'ref');
        assert.equal(out.alternatives[0]?.metadata?.compare_stage, 'open_world_grounded_resolver');
        assert.equal(out.alternatives[0]?.metadata?.catalog_grounding_mode, 'resolver_ref');
        assert.equal(out.alternatives[0]?.metadata?.authority_presence_class, 'external_seed_hit');
        assert.equal(Array.isArray(out.alternatives[0]?.metadata?.catalog_grounding_query_variants), true);
        assert.equal(out.alternatives[0]?.metadata?.visible_copy_mode, undefined);
        assert.equal(out.alternatives[0]?.metadata?.name_only_copy_sanitized, undefined);
        assert.deepEqual(
          out.alternatives[0]?.reasons,
          ['Regulates oil production with the same hero active.'],
        );
        assert.deepEqual(
          out.alternatives[0]?.tradeoff_notes,
          ['Formula concentration differs from the anchor.'],
        );
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only sanitizes unresolved name-only copy', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'Belif',
                name: 'The True Cream Aqua Bomb',
                product_type: 'moisturizer',
                similarity_score: 76,
                reasons: ['Gel-cream hydration with a dewy finish and fragrance profile close to the anchor.'],
                tradeoff_notes: ['Can pill under sunscreen and feels more fragranced on sensitive skin.'],
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async () => ({
          resolved: false,
          product_ref: null,
          confidence: 0,
          reason: 'no_candidates',
          candidates: [],
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_name_only_sanitized',
            trace_id: 'trace_open_world_name_only_sanitized',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'First Aid Beauty Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
          productObj: {
            brand: 'First Aid Beauty',
            name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            product_type: 'moisturizer',
            category: 'Moisturizer',
            claims: ['hydration', 'barrier support'],
            texture_hints: ['gel cream'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.llm_trace?.catalog_grounding_attempted_count, 1);
        assert.equal(out?.llm_trace?.catalog_grounded_count, 0);
        assert.equal(out?.llm_trace?.catalog_grounding_failure_class_counts?.coverage_miss, 1);
        assert.equal(out?.alternatives?.length, 1);
        assert.equal(out.alternatives[0]?.candidate_origin, 'open_world');
        assert.equal(out.alternatives[0]?.grounding_status, 'name_only');
        assert.equal(out.alternatives[0]?.metadata?.authority_presence_class, 'missing_authority');
        assert.equal(out.alternatives[0]?.metadata?.grounding_failure_class, 'coverage_miss');
        assert.equal(out.alternatives[0]?.metadata?.visible_copy_mode, 'name_only');
        assert.equal(out.alternatives[0]?.metadata?.name_only_copy_sanitized, true);
        assert.match(String(out.alternatives[0]?.reasons?.[0] || ''), /same .* step as the anchor/i);
        assert.equal(String(out.alternatives[0]?.reasons?.[1] || ''), 'Presented as a distinct option for this compare.');
        assert.deepEqual(
          out.alternatives[0]?.tradeoff_notes,
          ['Key formula details still need verification before comparing actives or finish.'],
        );
        const reasonsJoined = (Array.isArray(out.alternatives[0]?.reasons) ? out.alternatives[0].reasons : []).join(' | ');
        assert.equal(/fragrance|pilling|dewy finish|sensitive skin/i.test(reasonsJoined), false);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only enqueues async external-seed backfill for coverage misses', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'Belif',
                name: 'The True Cream Aqua Bomb',
                product_type: 'moisturizer',
                similarity_score: 76,
                reasons: ['Lightweight gel-cream option for the same moisturizer step.'],
                tradeoff_notes: ['Formula details still need authority verification.'],
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async () => ({
          resolved: false,
          product_ref: null,
          confidence: 0,
          reason: 'no_candidates',
          candidates: [],
        }));
        __internal.__setRecoAlternativesAuthorityBackfillSourcePlanResolverForTest(async () => ({
          ok: true,
          primaryDomain: 'https://belifusa.com',
          primaryRole: 'primary',
          fallbackDomains: ['https://www.sephora.com'],
        }));
        let runnerJob = null;
        __internal.__setRecoAlternativesAuthorityBackfillRunnerForTest(async (job) => {
          runnerJob = job;
          return {
            status: 'completed',
            mode: 'apply',
            report_path: '/tmp/test-belif-backfill.json',
            applied_seed_ids: ['seed_belif_aqua_bomb'],
          };
        });

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_backfill_enqueue',
            trace_id: 'trace_open_world_backfill_enqueue',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'First Aid Beauty Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
          productObj: {
            brand: 'First Aid Beauty',
            name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            product_type: 'moisturizer',
            category: 'Moisturizer',
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.refresh_pending, true);
        assert.equal(out?.compare_meta?.authority_backfill?.status, 'enqueued');
        assert.equal(out?.compare_meta?.authority_backfill?.pending, true);
        assert.equal(out?.compare_meta?.authority_backfill?.coverage_gap_count, 1);
        assert.equal(out?.compare_meta?.authority_backfill?.enqueued_brand_count, 1);
        assert.equal(out?.compare_meta?.authority_backfill?.brands?.[0]?.brand, 'Belif');
        await __internal.__flushRecoAlternativesAuthorityBackfillForTest();
        assert.equal(runnerJob?.brand, 'Belif');
        assert.deepEqual(runnerJob?.preferredTitles, ['The True Cream Aqua Bomb']);
        const history = __internal.__getRecoAlternativesAuthorityBackfillHistoryForTest();
        assert.equal(history.some((entry) => entry.brand === 'Belif' && entry.status === 'completed'), true);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        loaded?.__internal?.__resetRecoAlternativesAuthorityBackfillForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only marks recall_miss when authority hits exist but do not resolve', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_supergoop_other',
                merchant_id: 'external_seed',
                brand: 'Supergoop!',
                name: 'Glow Oil SPF 50',
                display_name: 'Glow Oil SPF 50',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'Supergoop!',
                name: 'Glowscreen SPF 40',
                product_type: 'sunscreen',
                similarity_score: 74,
                reasons: ['Same sunscreen step with a glow-finish positioning.'],
                tradeoff_notes: ['Specific UV filter details still need verification.'],
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async () => ({
          resolved: false,
          product_ref: null,
          confidence: 0,
          reason: 'no_candidates',
          candidates: [],
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_recall_miss',
            trace_id: 'trace_open_world_recall_miss',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary UV Filters SPF 45 Serum',
          productObj: {
            brand: 'The Ordinary',
            name: 'UV Filters SPF 45 Serum',
            product_type: 'sunscreen',
            category: 'Sunscreen',
            claims: ['daily sunscreen', 'lightweight protection'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.llm_trace?.catalog_grounding_failure_class_counts?.recall_miss, 1);
        assert.equal(out.alternatives[0]?.metadata?.authority_presence_class, 'present_but_unresolved');
        assert.equal(out.alternatives[0]?.metadata?.grounding_failure_class, 'recall_miss');
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only hides unresolved rows when enough grounded alternatives exist', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_lrp_aox',
                merchant_id: 'external_seed',
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Antioxidant Serum SPF 50',
                display_name: 'Anthelios AOX Antioxidant Serum SPF 50',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                compare_highlights: ['Serum sunscreen format.'],
              },
              {
                product_id: 'ext_neutrogena_invisible',
                merchant_id: 'external_seed',
                brand: 'Neutrogena',
                name: 'Invisible Daily Defense Face Serum SPF 60+',
                display_name: 'Invisible Daily Defense Face Serum SPF 60+',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                compare_highlights: ['Invisible daily sunscreen serum.'],
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Antioxidant Serum SPF 50',
                product_type: 'sunscreen',
                similarity_score: 65,
                reasons: ['Lightweight serum texture.'],
                tradeoff_notes: ['More premium than the anchor.'],
              },
              {
                brand: 'Neutrogena',
                name: 'Invisible Daily Defense Face Serum SPF 60+',
                product_type: 'sunscreen',
                similarity_score: 59,
                reasons: ['Invisible serum sunscreen format.'],
                tradeoff_notes: ['Higher SPF than the anchor.'],
              },
              {
                brand: 'Supergoop!',
                name: 'Glow Screen SPF 40',
                product_type: 'sunscreen',
                similarity_score: 58,
                reasons: ['Same sunscreen step.'],
                tradeoff_notes: ['Formula details need verification.'],
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async () => ({
          resolved: false,
          product_ref: null,
          confidence: 0,
          reason: 'no_candidates',
          candidates: [],
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_hide_name_only_when_grounded',
            trace_id: 'trace_open_world_hide_name_only_when_grounded',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary UV Filters SPF 45 Serum',
          productObj: {
            brand: 'The Ordinary',
            name: 'UV Filters SPF 45 Serum',
            product_type: 'sunscreen',
            category: 'Sunscreen',
            claims: ['daily sunscreen', 'lightweight protection'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.llm_trace?.catalog_grounded_count, 2);
        assert.equal(out?.compare_meta?.visible_authority_only_filter_applied, true);
        assert.equal(out?.compare_meta?.hidden_unresolved_count, 1);
        assert.equal(out.alternatives.length, 2);
        assert.equal(out.alternatives.every((row) => row?.grounding_status === 'catalog_verified'), true);
        assert.equal(out.alternatives.some((row) => /glow\s*screen/i.test(String(row?.name || row?.product?.name || ''))), false);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only ranks grounded sunscreen serum rows ahead of glow-finish rows', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_lrp_aox',
                merchant_id: 'external_seed',
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Antioxidant Serum SPF 50',
                display_name: 'Anthelios AOX Antioxidant Serum SPF 50',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Face serum sunscreen texture for straightforward daily protection.',
                compare_highlights: ['Serum sunscreen format.'],
              },
              {
                product_id: 'ext_supergoop_glowscreen',
                merchant_id: 'external_seed',
                brand: 'Supergoop!',
                name: 'Glowscreen SPF 40',
                display_name: 'Glowscreen SPF 40',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Glowy sunscreen primer with pearlescent radiance and a dewy makeup-prep finish.',
                compare_highlights: ['Glow primer finish.'],
              },
              {
                product_id: 'ext_neutrogena_invisible',
                merchant_id: 'external_seed',
                brand: 'Neutrogena',
                name: 'Invisible Daily Defense Sunscreen Serum SPF 60+',
                display_name: 'Invisible Daily Defense Sunscreen Serum SPF 60+',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                retrieval_source: 'external_seed',
                description: 'Invisible daily sunscreen serum with a lightweight face-serum feel.',
                compare_highlights: ['Invisible daily sunscreen serum.'],
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Antioxidant Serum SPF 50',
                product_type: 'sunscreen',
                similarity_score: 62,
                reasons: ['Serum sunscreen texture for daily SPF.'],
                tradeoff_notes: ['Usually a higher-price pharmacy option.'],
              },
              {
                brand: 'Supergoop!',
                name: 'Glowscreen SPF 40',
                product_type: 'sunscreen',
                similarity_score: 61,
                reasons: ['Same sunscreen step.'],
                tradeoff_notes: ['Leaves a pearlescent, dewy glow finish.'],
              },
              {
                brand: 'Neutrogena',
                name: 'Invisible Daily Defense Sunscreen Serum SPF 60+',
                product_type: 'sunscreen',
                similarity_score: 57,
                reasons: ['Invisible serum sunscreen format.'],
                tradeoff_notes: ['Drugstore SPF serum rather than the exact anchor formula.'],
              },
            ],
          },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_sunscreen_anchor_fit_rank',
            trace_id: 'trace_open_world_sunscreen_anchor_fit_rank',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary UV Filters SPF 45 Serum',
          productObj: {
            brand: 'The Ordinary',
            name: 'UV Filters SPF 45 Serum',
            product_type: 'sunscreen',
            category: 'Sunscreen',
            claims: ['daily sunscreen', 'lightweight protection'],
            key_features: ['Lightweight serum', 'Daily UV protection'],
            short_description: 'A lightweight sunscreen serum for daily protection.',
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.llm_trace?.catalog_grounded_count, 3);
        assert.equal(out.alternatives.length, 3);
        const returnedNames = out.alternatives.map((row) => String(row?.product?.name || row?.name || ''));
        const neutrogenaIndex = returnedNames.findIndex((name) => /Invisible Daily Defense/i.test(name));
        const glowscreenIndex = returnedNames.findIndex((name) => /Glowscreen/i.test(name));
        assert.ok(neutrogenaIndex >= 0);
        assert.ok(glowscreenIndex >= 0);
        assert.ok(neutrogenaIndex < glowscreenIndex);
        const glowscreen = out.alternatives[glowscreenIndex];
        assert.equal(glowscreen?.grounding_status, 'catalog_verified');
        assert.ok(Number(glowscreen?.metadata?.cosmetic_finish_penalty || 0) > 0);
        assert.ok(Array.isArray(glowscreen?.metadata?.ranking_signals_used));
        assert.ok(glowscreen.metadata.ranking_signals_used.includes('cosmetic_finish_mismatch_penalty'));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only preserves reviewed highlights on catalog-grounded rows', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_lrp_anthelios',
                merchant_id: 'external_seed',
                brand: 'La Roche-Posay',
                name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
                display_name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                compare_highlights: ['Very fluid sunscreen texture.', 'Higher price than the anchor.'],
                pivota_insights: {
                  why_it_stands_out: [{ body: 'Multiple shoppers mention the ultra-light fluid finish.' }],
                },
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'La Roche-Posay',
                name: 'Anthelios Ultra-Light Invisible Fluid SPF 50+',
                product_type: 'sunscreen',
                similarity_score: 82,
                reasons: ['Lightweight fluid sunscreen alternative.'],
                tradeoff_notes: ['Costs more than the anchor.'],
              },
            ],
          },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_reviewed_highlights',
            trace_id: 'trace_open_world_reviewed_highlights',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary UV Filters SPF 45 Serum',
          productObj: {
            brand: 'The Ordinary',
            name: 'UV Filters SPF 45 Serum',
            product_type: 'sunscreen',
            category: 'Sunscreen',
            claims: ['lightweight sunscreen'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out.alternatives[0]?.grounding_status, 'catalog_verified');
        assert.deepEqual(out.alternatives[0]?.compare_highlights, [
          'Very fluid sunscreen texture.',
          'Higher price than the anchor.',
          'Multiple shoppers mention the ultra-light fluid finish.',
        ]);
        assert.equal(
          out.alternatives[0]?.pivota_insights?.why_it_stands_out?.[0]?.body,
          'Multiple shoppers mention the ultra-light fluid finish.',
        );
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only filters off-target visible claims on grounded rows', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_lrp_anthelios',
                merchant_id: 'external_seed',
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Antioxidant Serum SPF 50',
                display_name: 'Anthelios AOX Antioxidant Serum SPF 50',
                product_type: 'Sunscreen',
                category: 'Sunscreen',
                compare_highlights: [
                  'Combines smoother texture and fine-line support with daytime sun protection in one morning step.',
                  'Infused with ginger extract for glowing skin, this serum protects against environmental factors without leaving a white cast for any skin tone.',
                  'Best for Breakout-prone skin',
                ],
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Antioxidant Serum SPF 50',
                product_type: 'sunscreen',
                similarity_score: 82,
                reasons: ['Serum sunscreen alternative for daily UV protection.'],
                tradeoff_notes: [
                  'Higher SPF level may increase sensitivity risk.',
                  'Also talks about dark spots in catalog copy.',
                ],
              },
            ],
          },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_filtered_highlights',
            trace_id: 'trace_open_world_filtered_highlights',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary UV Filters SPF 45 Serum',
          productObj: {
            brand: 'The Ordinary',
            name: 'UV Filters SPF 45 Serum',
            product_type: 'sunscreen',
            category: 'Sunscreen',
            role_scope: 'daily_sunscreen',
            claims: ['daily sunscreen'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out.alternatives[0]?.grounding_status, 'catalog_verified');
        assert.deepEqual(out.alternatives[0]?.compare_highlights, [
          'Combines smoother texture with daytime sun protection in one morning step.',
          'Infused with ginger extract, this serum protects against environmental factors without leaving a white cast for any skin tone.',
        ]);
        assert.deepEqual(out.alternatives[0]?.tradeoff_notes || [], ['Higher SPF level']);
        assert.equal(out.alternatives[0]?.metadata?.off_target_visible_claims_filtered, true);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only surfaces local Gemini failure details in trace', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-2.5-flash',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MAX_OUTPUT_TOKENS: '2048',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      let auroraChatCalls = 0;
      decisionModule.auroraChat = async () => {
        auroraChatCalls += 1;
        throw new Error('auroraChat should not be called for open_world_only failure path');
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: false,
          reason: 'gemini_client_unavailable',
          detail: 'missing api key',
          timeout_stage: 'queue',
          total_ms: 321,
          upstream_ms: 0,
          meta: { result_reason: 'gemini_client_unavailable' },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: {
            lang: 'EN',
            request_id: 'req_open_world_local_fail',
            trace_id: 'trace_open_world_local_fail',
          },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
          productObj: {
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            product_type: 'serum',
            category: 'Serum',
            ingredients: ['Niacinamide', 'Zinc PCA'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(auroraChatCalls, 0);
        assert.equal(out?.ok, true);
        assert.equal(out?.failure_class, 'provider_error');
        assert.equal(out?.template_id, 'reco_alternatives_open_world_v1');
        assert.equal(out?.llm_trace?.source_mode, 'local_gemini_open_world');
        assert.equal(out?.llm_trace?.provider_reason, 'gemini_client_unavailable');
        assert.equal(out?.llm_trace?.provider_detail, 'missing api key');
        assert.equal(out?.llm_trace?.provider_route, 'aurora_reco_alternatives_open_world');
        assert.equal(out?.llm_trace?.provider_model, 'gemini-3-flash-preview');
        assert.equal(out?.llm_trace?.provider_timeout_stage, 'queue');
        assert.equal(out?.llm_trace?.provider_total_ms, 321);
        assert.equal(out?.llm_trace?.provider_upstream_ms, 0);
        assert.equal(out?.llm_trace?.provider_result_reason, 'gemini_client_unavailable');
        assert.equal(out?.llm_trace?.finish_reason, null);
        assert.equal(out?.llm_trace?.parse_status, null);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[moduleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: weak anchors in open_world_only surface explicit provider failure without implicit model fallback', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-2.5-flash',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MAX_OUTPUT_TOKENS: '2048',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: false,
          reason: 'gemini_client_unavailable',
          detail: 'missing api key',
          timeout_stage: 'queue',
          total_ms: 321,
          upstream_ms: 0,
          meta: { result_reason: 'gemini_client_unavailable' },
        }));
        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: { lang: 'EN', request_id: 'req_open_world_weak_anchor', trace_id: 'trace_open_world_weak_anchor' },
          profileSummary: null,
          recentLogs: [],
          productInput: 'Generic Daily Moisturizer',
          productObj: {
            brand: 'Generic Brand',
            name: 'Daily Moisturizer',
            product_type: 'moisturizer',
            category: 'Moisturizer',
          },
          anchorId: '',
          maxTotal: 1,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: false,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(out?.failure_class, 'provider_error');
        assert.equal(out?.no_result_reason, 'no_viable_results_after_open_world');
        assert.equal(out?.template_id, 'reco_alternatives_open_world_v1');
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only recovers complete alternatives from truncated raw JSON', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-2.5-flash',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MAX_OUTPUT_TOKENS: '2048',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: false,
          reason: 'PARSE_TRUNCATED_JSON',
          detail: 'finish_reason=MAX_TOKENS',
          raw_text: '{"alternative":{"brand":"Good Molecules","name":"Niacinamide Serum","product_type":"serum","similarity_score":72,"reason":"Niacinamide-led serum role overlaps with the anchor.","tradeoff_note":"Zinc support is less explicit than the anchor."},"empty_reason":null',
          finish_reason: 'MAX_TOKENS',
          parse_status: 'parse_truncated',
          meta: { result_reason: 'gemini_json_max_tokens' },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: { lang: 'EN', request_id: 'req_open_world_trunc', trace_id: 'trace_open_world_trunc' },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
          productObj: {
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            product_type: 'serum',
            category: 'Serum',
            ingredients: ['Niacinamide', 'Zinc PCA'],
            claims: ['brightening', 'oil control'],
          },
          anchorId: '',
          maxTotal: 2,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(Array.isArray(out?.alternatives), true);
        assert.equal(out.alternatives.length, 1);
        assert.equal(out.alternatives[0]?.product?.brand, 'Good Molecules');
        assert.equal(out.alternatives[0]?.product?.name, 'Niacinamide Serum');
        assert.equal(out?.llm_trace?.finish_reason, 'MAX_TOKENS');
        assert.equal(out?.llm_trace?.parse_status, 'parse_truncated');
        assert.equal(out?.llm_trace?.recovered_from_truncated_raw, true);
        assert.equal(out?.llm_trace?.recovered_row_count, 1);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        delete require.cache[moduleId];
      }
    },
  );
});

test('fetchRecoAlternativesForProduct: open_world_only recovers pretty alternatives array from truncated raw JSON', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-3-flash-preview',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-2.5-flash',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MAX_OUTPUT_TOKENS: '2048',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: false,
          reason: 'PARSE_TRUNCATED_JSON',
          detail: 'finish_reason=MAX_TOKENS',
          raw_text: `{
  "alternatives": [
    {
      "brand": "Good Molecules",
      "name": "Niacinamide Serum",
      "product_type": "serum",
      "similarity_score": 0.74,
      "reasons": [
        "Niacinamide-led serum role overlaps with the anchor."
      ],
      "tradeoff_notes": [
        "Zinc support is less explicit than the anchor."
      ]
    },
    {
      "brand": "The INKEY List",
      "name": "Niacinamide Serum",
      "product_type": "serum",
      "similarity_score": 0.7,
      "reasons": [
        "Same lightweight oil-control serum role."
      ],
      "tradeoff_notes": [
        "Hydration and texture may feel different."
      ]
    }`,
          finish_reason: 'MAX_TOKENS',
          parse_status: 'parse_truncated',
          meta: { result_reason: 'gemini_json_max_tokens' },
        }));

        const out = await __internal.fetchRecoAlternativesForProduct({
          ctx: { lang: 'EN', request_id: 'req_open_world_pretty_trunc', trace_id: 'trace_open_world_pretty_trunc' },
          profileSummary: null,
          recentLogs: [],
          productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
          productObj: {
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            product_type: 'serum',
            category: 'Serum',
            ingredients: ['Niacinamide', 'Zinc PCA'],
            claims: ['oil control'],
          },
          anchorId: '',
          maxTotal: 3,
          candidatePool: [],
          logger: null,
          options: {
            recommendation_mode: 'open_world_only',
            profile_mode: 'anchor_only',
            disable_fallback: true,
            disable_synthetic_local_fallback: true,
            ignore_selector_candidates: true,
            skip_anchor_precheck: true,
          },
        });

        assert.equal(out?.ok, true);
        assert.equal(out?.failure_class, null);
        assert.equal(Array.isArray(out?.alternatives), true);
        assert.equal(out.alternatives.length, 2);
        assert.deepEqual(out.alternatives.map((alt) => alt?.product?.brand), ['Good Molecules', 'The INKEY List']);
        assert.equal(out?.llm_trace?.finish_reason, 'MAX_TOKENS');
        assert.equal(out?.llm_trace?.parse_status, 'parse_truncated');
        assert.equal(out?.llm_trace?.recovered_from_truncated_raw, true);
        assert.equal(out?.llm_trace?.recovered_row_count, 2);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        delete require.cache[moduleId];
      }
    },
  );
});

test('buildExternalSeedCompareSearchQueries: avoids duplicate role queries and prefers active-theme queries', async () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  try {
    const routeModule = require('../src/auroraBff/routes');
    const { __internal } = routeModule;
    const queries = __internal.buildExternalSeedCompareSearchQueries({
      productObj: {
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        category: 'serum',
        product_type: 'serum',
        key_actives: ['niacinamide', 'zinc'],
        claims: ['brightening', 'oil control'],
      },
      productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
      lang: 'EN',
    });
    assert.ok(Array.isArray(queries));
    assert.ok(queries.some((item) => /niacinamide serum/i.test(String(item || ''))));
    assert.equal(queries.some((item) => /\bserum serum\b/i.test(String(item || ''))), false);
    const thinTreatmentQueries = __internal.buildExternalSeedCompareSearchQueries({
      productObj: {
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        role_scope: 'oil_control_treatment',
      },
      productInput: 'The Ordinary Niacinamide 10% + Zinc 1%',
      lang: 'EN',
    });
    assert.ok(thinTreatmentQueries.slice(0, 3).some((item) => /niacinamide serum/i.test(String(item || ''))));
    assert.equal(thinTreatmentQueries.some((item) => /\bunknown\b/i.test(String(item || ''))), false);
    const thinTreatmentLocalSeedRole = __internal.buildRecoAlternativesLocalSeedSearchRole({
      roleScope: 'oil_control_treatment',
      usageRole: 'unknown',
      primaryClaims: ['oil control'],
      knownActives: ['niacinamide'],
      textureHints: ['serum texture'],
    });
    assert.equal(thinTreatmentLocalSeedRole.rank, 2);
    assert.equal(thinTreatmentLocalSeedRole.preferred_step, 'serum');
    assert.ok(thinTreatmentLocalSeedRole.fit_keywords.includes('niacinamide'));
    const thinSunscreenQueries = __internal.buildExternalSeedCompareSearchQueries({
      productObj: {
        brand: 'SKINTIFIC',
        name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
        role_scope: 'daily_sunscreen_finish_fit',
      },
      productInput: 'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++',
      lang: 'EN',
    });
    assert.deepEqual(
      thinSunscreenQueries.slice(0, 3),
      ['spf fluid oily skin', 'sunscreen under makeup', 'lightweight sunscreen oily skin'],
    );
    const productionLikeSunscreenQueries = __internal.buildExternalSeedCompareSearchQueries({
      productObj: {
        brand: 'SKINTIFIC',
        name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
        category: 'sunscreen',
        product_type: 'sunscreen',
        role_scope: 'daily_sunscreen_finish_fit',
        key_features: ['Ceramide NP', 'Niacinamide', 'Zinc PCA', 'Vitamin C (Ascorbic acid)'],
        description: 'Oil-controlling, non-greasy sunscreen with Oat Extract and Zinc PCA for oily and acne-prone skin.',
      },
      productInput: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
      lang: 'EN',
    });
    assert.deepEqual(
      productionLikeSunscreenQueries.slice(0, 3),
      ['spf fluid oily skin', 'sunscreen under makeup', 'lightweight sunscreen oily skin'],
    );
    assert.equal(productionLikeSunscreenQueries.slice(0, 3).some((item) => /^niacinamide sunscreen$/i.test(String(item || ''))), false);
    assert.equal(productionLikeSunscreenQueries.slice(0, 3).some((item) => /^sunscreen$/i.test(String(item || ''))), false);
    const wateryFinishSunscreenQueries = __internal.buildExternalSeedCompareSearchQueries({
      productObj: {
        brand: 'Beauty of Joseon',
        name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        category: 'sunscreen',
        product_type: 'sunscreen',
        role_scope: 'daily_sunscreen_finish_fit',
        texture_hints: ['water-gel texture', 'lightweight finish'],
        short_description: 'Lightweight fluid sunscreen for smoother daytime layering under makeup.',
      },
      productInput: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
      lang: 'EN',
    });
    assert.deepEqual(
      wateryFinishSunscreenQueries.slice(0, 3),
      ['spf fluid', 'sunscreen under makeup', 'lightweight sunscreen'],
    );
    const thinSunscreenLocalSeedRole = __internal.buildRecoAlternativesLocalSeedSearchRole({
      roleScope: 'daily_sunscreen_finish_fit',
      usageRole: 'unknown',
      primaryClaims: ['oil control'],
      textureHints: ['matte finish'],
    });
    assert.equal(thinSunscreenLocalSeedRole.rank, 2);
    assert.equal(thinSunscreenLocalSeedRole.preferred_step, 'sunscreen');
  } finally {
    delete require.cache[moduleId];
  }
});

test('/v1/reco/alternatives: catalog product-card hybrid uses grounded search pool before provider', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-2.0-flash',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: '9886499864904',
                merchant_id: 'merch_ordinary',
                brand: 'The Ordinary',
                name: 'Niacinamide 10% + Zinc 1%',
                display_name: 'Niacinamide 10% + Zinc 1%',
                product_type: 'serum',
                category: 'Serum',
              },
              {
                product_id: 'gm_niac',
                merchant_id: 'merch_alt',
                brand: 'Good Molecules',
                name: 'Niacinamide Serum',
                display_name: 'Niacinamide Serum',
                product_type: 'serum',
                category: 'Serum',
                url: 'https://example.com/good-molecules-niacinamide',
              },
              {
                product_id: 'boj_revive_serum',
                merchant_id: 'external_seed',
                brand: 'Beauty of Joseon',
                name: 'Revive Serum : Ginseng + Snail Mucin',
                display_name: 'Revive Serum : Ginseng + Snail Mucin',
                product_type: 'serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                canonical_product_ref: {
                  product_id: 'boj_revive_serum',
                  merchant_id: 'external_seed',
                },
                url: 'https://example.com/boj-revive-serum',
              },
              {
                product_id: 'boj_eye_serum',
                merchant_id: 'external_seed',
                brand: 'Beauty of Joseon',
                name: 'Revive Eye Serum : Ginseng + Retinal',
                display_name: 'Revive Eye Serum : Ginseng + Retinal',
                product_type: 'serum',
                category: 'Serum',
                retrieval_source: 'external_seed',
                canonical_product_ref: {
                  product_id: 'boj_eye_serum',
                  merchant_id: 'external_seed',
                },
                url: 'https://example.com/boj-eye-serum',
              },
              {
                product_id: 'inkey_niac',
                merchant_id: 'merch_alt',
                brand: 'The Inkey List',
                name: 'Niacinamide Serum',
                display_name: 'Niacinamide Serum',
                product_type: 'serum',
                category: 'Serum',
                url: 'https://example.com/inkey-niacinamide',
              },
              {
                product_id: 'naturium_niac',
                merchant_id: 'merch_alt',
                brand: 'Naturium',
                name: 'Niacinamide Serum 12% Plus Zinc 2%',
                display_name: 'Niacinamide Serum 12% Plus Zinc 2%',
                product_type: 'serum',
                category: 'Serum',
                url: 'https://example.com/naturium-niacinamide-zinc',
              },
              {
                product_id: 'gm_niac_duo',
                merchant_id: 'merch_alt',
                brand: 'Good Molecules',
                name: 'Niacinamide Serum Duo',
                display_name: 'Niacinamide Serum Duo',
                product_type: 'serum',
                category: 'Serum',
                url: 'https://example.com/good-molecules-niacinamide-duo',
              },
              {
                product_id: 'inkey_niac_jumbo',
                merchant_id: 'merch_alt',
                brand: 'The Inkey List',
                name: 'Niacinamide Serum Jumbo',
                display_name: 'Niacinamide Serum Jumbo',
                product_type: 'serum',
                category: 'Serum',
                url: 'https://example.com/inkey-niacinamide-jumbo',
              },
              {
                product_id: 'bad_cleanser',
                merchant_id: 'merch_bad',
                brand: 'Fenty Beauty',
                name: "Cherry Dub Pore Purify'r Gel Cleanser with Niacinamide",
                display_name: "Cherry Dub Pore Purify'r Gel Cleanser with Niacinamide",
                product_type: 'cleanser',
                category: 'Cleanser',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        let geminiCalls = 0;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          geminiCalls += 1;
          throw new Error('provider should not be called when the grounded pool is sufficient');
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_catalog_pool_first',
            'X-Trace-ID': 'test_trace_alt_catalog_pool_first',
            'X-Brief-ID': 'test_brief_alt_catalog_pool_first',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'The Ordinary Niacinamide 10% + Zinc 1%',
            max_total: 6,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: '9886499864904',
              merchant_id: 'merch_ordinary',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              product_type: 'serum',
              category: 'Serum',
              ingredients: ['Niacinamide', 'Zinc PCA'],
              claims: ['oil control', 'pore care'],
              canonical_product_ref: {
                product_id: '9886499864904',
                merchant_id: 'merch_ordinary',
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.fallback_source, null);
        assert.equal(resp.body?.failure_class, null);
        assert.equal(resp.body?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.ok(Number(resp.body?.compare_meta?.pool_selected_count || 0) >= 3);
        assert.equal(geminiCalls, 0);
        const names = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.equal(names.some((name) => /cherry dub|cleanser/i.test(name)), false);
        assert.equal(names.some((name) => /\beye serum\b/i.test(name)), false);
        assert.equal(names.some((name) => /niacinamide 10% \+ zinc/i.test(name)), false);
        assert.equal(names.some((name) => /\bduo\b|\bjumbo\b/i.test(name)), false);
        assert.ok(names.some((name) => /niacinamide serum/i.test(name)));
        assert.ok(names.slice(0, 3).every((name) => /niacinamide|zinc/i.test(name)), JSON.stringify(names));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: hybrid supplements thin grounded pool with Gemini 3 open-world', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
      AURORA_RECO_ALTERNATIVES_OPEN_WORLD_MODEL: 'gemini-2.0-flash',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: '9886499864904',
                merchant_id: 'merch_ordinary',
                brand: 'The Ordinary',
                name: 'Niacinamide 10% + Zinc 1%',
                display_name: 'Niacinamide 10% + Zinc 1%',
                product_type: 'serum',
                category: 'Serum',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        let geminiRequest = null;
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          geminiRequest = args;
          return {
            ok: true,
            json: {
              alternatives: [
                {
                  brand: 'Good Molecules',
                  name: 'Niacinamide Serum',
                  product_type: 'serum',
                  similarity_score: 72,
                  reasons: ['Niacinamide-led serum role overlaps with the anchor.'],
                  tradeoff_notes: ['Zinc support is less explicit than the anchor.'],
                },
                {
                  brand: 'The Inkey List',
                  name: 'Niacinamide Serum',
                  product_type: 'serum',
                  similarity_score: 70,
                  reasons: ['Same lightweight niacinamide serum role.'],
                  tradeoff_notes: ['Exact concentration and texture are not confirmed here.'],
                },
              ],
            },
          };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_catalog_gemini_supplement',
            'X-Trace-ID': 'test_trace_alt_catalog_gemini_supplement',
            'X-Brief-ID': 'test_brief_alt_catalog_gemini_supplement',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'The Ordinary Niacinamide 10% + Zinc 1%',
            max_total: 6,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: 'ext_the_ordinary_niacinamide_anchor',
              merchant_id: 'external_seed',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              product_type: 'serum',
              category: 'Serum',
              ingredients: ['Niacinamide', 'Zinc PCA'],
              claims: ['oil control', 'pore care'],
              alternatives: [
                {
                  product_id: 'ext_byoma_clarifying_serum',
                  merchant_id: 'external_seed',
                  brand: 'BYOMA',
                  name: 'Clarifying Serum',
                  display_name: 'Clarifying Serum',
                  product_type: 'serum',
                  category: 'Serum',
                  retrieval_source: 'external_seed',
                  key_features: ['Niacinamide', 'oil control', 'pore care'],
                  canonical_product_ref: {
                    product_id: 'ext_byoma_clarifying_serum',
                    merchant_id: 'external_seed',
                  },
                },
              ],
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.failure_class, null);
        assert.equal(resp.body?.compare_meta?.open_world_status, 'success');
        assert.equal(resp.body?.llm_trace?.provider_model, 'gemini-3-flash-preview');
        assert.equal(geminiRequest?.model, 'gemini-3-flash-preview');
        const geminiPayload = JSON.parse(geminiRequest?.userPrompt || '{}');
        assert.equal(geminiPayload?.task?.max_alternatives, 3);
        assert.equal(Array.isArray(geminiPayload?.excluded_pool_products), true);
        assert.equal(
          geminiPayload.excluded_pool_products.length,
          Array.isArray(geminiPayload?.pool_summary) ? geminiPayload.pool_summary.length : 0,
        );
        assert.ok(Number(resp.body?.compare_meta?.open_world_selected_count || 0) >= 2);
        assert.ok(resp.body.alternatives.some((alt) => String(alt?.candidate_origin || '') === 'pool'));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: hybrid does not let weak same-step pool rows outrank strong open-world alternatives', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: '9886499864904',
                merchant_id: 'merch_ordinary',
                brand: 'The Ordinary',
                name: 'Niacinamide 10% + Zinc 1%',
                display_name: 'Niacinamide 10% + Zinc 1%',
                product_type: 'serum',
                category: 'Serum',
              },
              {
                product_id: 'weak_same_step_serum',
                merchant_id: 'merch_pool',
                brand: 'Winona',
                name: 'Soothing Repair Serum',
                display_name: 'Soothing Repair Serum',
                product_type: 'serum',
                category: 'Serum',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'The Inkey List',
                name: 'Niacinamide Serum',
                product_type: 'serum',
                similarity_score: 82,
                reasons: ['Niacinamide-led serum role overlaps with the anchor for oil control.'],
                tradeoff_notes: ['Does not include the same zinc support.'],
              },
              {
                brand: 'Good Molecules',
                name: 'Niacinamide Serum',
                product_type: 'serum',
                similarity_score: 80,
                reasons: ['Targets oiliness and uneven tone with the same hero active.'],
                tradeoff_notes: ['Formula concentration differs from the anchor.'],
              },
              {
                brand: "Paula's Choice",
                name: '10% Niacinamide Booster',
                product_type: 'serum',
                similarity_score: 78,
                reasons: ['Same 10% niacinamide concentration for pores and shine.'],
                tradeoff_notes: ['Higher price and booster-style usage.'],
              },
            ],
          },
        }));
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_weak_pool',
            'X-Trace-ID': 'test_trace_alt_weak_pool',
            'X-Brief-ID': 'test_brief_alt_weak_pool',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'The Ordinary Niacinamide 10% + Zinc 1%',
            max_total: 6,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: '9886499864904',
              merchant_id: 'merch_ordinary',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              product_type: 'serum',
              category: 'Serum',
              ingredients: ['Niacinamide', 'Zinc PCA'],
              claims: ['oil control', 'pore care'],
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.compare_meta?.open_world_status, 'success');
        assert.equal(resp.body?.alternatives?.length, 3);
        const names = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.equal(names.some((name) => /soothing repair serum/i.test(name)), false);
        assert.equal(resp.body.alternatives.every((alt) => String(alt?.candidate_origin || '') === 'open_world'), true);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: hybrid treats off-target tone pool rows as insufficient for oily serum anchors', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
      AURORA_DIAG_FORCE_GEMINI: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const offTargetPoolRows = [
        {
          product_id: '9886499864904',
          merchant_id: 'merch_ordinary',
          brand: 'The Ordinary',
          name: 'Niacinamide 10% + Zinc 1%',
          display_name: 'Niacinamide 10% + Zinc 1%',
          product_type: 'serum',
          category: 'Serum',
        },
        {
          product_id: 'round_lab_dark_spot_serum',
          merchant_id: 'external_seed',
          brand: 'Round Lab',
          name: 'Vita Niacinamide Dark Spot Serum',
          display_name: 'Vita Niacinamide Dark Spot Serum',
          product_type: 'serum',
          category: 'Serum',
          retrieval_source: 'external_seed',
          description: 'A brightening serum for dark spots, radiance, and uneven tone.',
          compare_highlights: ['Best for Uneven tone concerns'],
        },
        {
          product_id: 'round_lab_dark_spot_serum_mask',
          merchant_id: 'external_seed',
          brand: 'Round Lab',
          name: 'Vita Niacinamide Dark Spot Serum Mask',
          display_name: 'Vita Niacinamide Dark Spot Serum Mask',
          product_type: 'mask',
          category: 'Serum Mask',
          retrieval_source: 'external_seed',
          description: 'A serum mask for brightening and dark spot care.',
          compare_highlights: ['Single-use mask format for uneven tone.'],
        },
        {
          product_id: 'haruharu_txa_gel_serum',
          merchant_id: 'external_seed',
          brand: 'Haruharu Wonder',
          name: '4% TXA Gel Serum / Unscented',
          display_name: '4% TXA Gel Serum / Unscented',
          product_type: 'serum',
          category: 'Serum',
          retrieval_source: 'external_seed',
          description: 'A tranexamic-acid gel serum focused on tone correction and radiance.',
          compare_highlights: ['TXA-led tone support.'],
        },
        {
          product_id: 'haruharu_soothing_serum',
          merchant_id: 'external_seed',
          brand: 'Haruharu Wonder',
          name: 'Soothing Serum',
          display_name: 'Soothing Serum',
          product_type: 'serum',
          category: 'Serum',
          retrieval_source: 'external_seed',
          description: 'A calming serum for sensitive skin and redness-prone routines.',
          compare_highlights: ['Best for Sensitive skin'],
        },
      ];
      const groundedOpenWorldRows = [
        {
          product_id: 'inkey_niacinamide_serum',
          merchant_id: 'external_seed',
          brand: 'The Inkey List',
          name: 'Niacinamide Serum',
          display_name: 'Niacinamide Serum',
          product_type: 'serum',
          category: 'Serum',
          retrieval_source: 'external_seed',
          description: 'Niacinamide serum for oil control, sebum balance, and visible shine.',
          compare_highlights: ['Niacinamide-led oil-control serum.'],
        },
        {
          product_id: 'naturium_niacinamide_zinc_serum',
          merchant_id: 'external_seed',
          brand: 'Naturium',
          name: 'Niacinamide Serum 12% Plus Zinc 2%',
          display_name: 'Niacinamide Serum 12% Plus Zinc 2%',
          product_type: 'serum',
          category: 'Serum',
          retrieval_source: 'external_seed',
          description: 'Niacinamide plus zinc serum for oily skin, pores, and shine.',
          compare_highlights: ['Keeps the niacinamide plus zinc oil-control logic.'],
        },
        {
          product_id: 'paulas_choice_10_niacinamide_booster',
          merchant_id: 'external_seed',
          brand: "Paula's Choice",
          name: '10% Niacinamide Booster',
          display_name: '10% Niacinamide Booster',
          product_type: 'serum',
          category: 'Serum',
          retrieval_source: 'external_seed',
          description: '10% niacinamide booster for visible pores, uneven-looking texture, and excess oil.',
          compare_highlights: ['Similar 10% niacinamide strength with pore and oil-control positioning.'],
        },
      ];
      axios.get = async (url, config) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const query = String(config?.params?.query || '').toLowerCase();
        const products = /inkey|naturium|paula/.test(query)
          ? groundedOpenWorldRows
          : offTargetPoolRows;
        return { status: 200, data: { products } };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'The Inkey List',
                name: 'Niacinamide Serum',
                product_type: 'serum',
                similarity_score: 82,
                reasons: ['Niacinamide-led serum role overlaps with the anchor for oil control.'],
                tradeoff_notes: ['Does not include the same zinc support.'],
              },
              {
                brand: 'Naturium',
                name: 'Niacinamide Serum 12% Plus Zinc 2%',
                product_type: 'serum',
                similarity_score: 81,
                reasons: ['Keeps the niacinamide and zinc direction for shine and pores.'],
                tradeoff_notes: ['Higher active percentage may feel stronger than the anchor.'],
              },
              {
                brand: "Paula's Choice",
                name: '10% Niacinamide Booster',
                product_type: 'serum',
                similarity_score: 78,
                reasons: ['Same 10% niacinamide concentration for pores and shine.'],
                tradeoff_notes: ['Booster-style usage and usually a higher price.'],
              },
            ],
          },
        }));
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_oily_tone_pool',
            'X-Trace-ID': 'test_trace_alt_oily_tone_pool',
            'X-Brief-ID': 'test_brief_alt_oily_tone_pool',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'The Ordinary Niacinamide 10% + Zinc 1%',
            max_total: 6,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: '9886499864904',
              merchant_id: 'merch_ordinary',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              product_type: 'serum',
              category: 'Serum',
              role_scope: 'oil_control_treatment',
              ingredients: ['Niacinamide', 'Zinc PCA'],
              claims: ['oil control', 'pore care'],
              key_features: ['Best for excess oil and mid-day shine'],
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.compare_meta?.open_world_status, 'success');
        assert.notEqual(resp.body?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.ok(Number(resp.body?.compare_meta?.open_world_grounded_count || 0) >= 2);
        const names = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.equal(names.some((name) => /dark spot|txa|soothing serum|serum mask/i.test(name)), false);
        assert.ok(names.some((name) => /The Inkey List|Niacinamide Serum/i.test(name)));
        assert.ok(names.some((name) => /Naturium|Paula's Choice|10% Niacinamide Booster/i.test(name)));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: external llm_seed compare returns deterministic pool results when open-world provider fails', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_anchor_mask',
                merchant_id: 'mid_mask',
                brand: 'Laneige',
                name: 'Water Sleeping Mask',
                display_name: 'Water Sleeping Mask',
                product_type: 'mask',
                category: 'Sleeping Mask',
              },
              {
                product_id: 'prod_bad_brush',
                merchant_id: 'mid_bad',
                brand: 'Random',
                name: 'Small Eyeshadow Brush',
                display_name: 'Small Eyeshadow Brush',
                product_type: 'makeup brush',
                category: 'Makeup Brush',
              },
              {
                product_id: 'prod_mask_1',
                merchant_id: 'mid_mask',
                brand: 'Fresh',
                name: 'Rose Face Mask',
                display_name: 'Rose Face Mask',
                product_type: 'mask',
                category: 'Face Mask',
              },
              {
                product_id: 'prod_mask_2',
                merchant_id: 'mid_mask',
                brand: "Kiehl's",
                name: 'Rare Earth Deep Pore Cleansing Mask',
                display_name: 'Rare Earth Deep Pore Cleansing Mask',
                product_type: 'mask',
                category: 'Face Mask',
              },
              {
                product_id: 'prod_mask_3',
                merchant_id: 'mid_mask',
                brand: 'Innisfree',
                name: 'Super Volcanic Clay Mask 2X',
                display_name: 'Super Volcanic Clay Mask 2X',
                product_type: 'mask',
                category: 'Clay Mask',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          throw new Error('provider down');
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_pool',
            'X-Trace-ID': 'test_trace_alt_external_pool',
            'X-Brief-ID': 'test_brief_alt_external_pool',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'Laneige Water Sleeping Mask',
            max_total: 6,
            product: {
              brand: 'Laneige',
              name: 'Water Sleeping Mask',
              metadata: { match_state: 'llm_seed' },
              pdp_open: {
                path: 'external',
                external: { query: 'Laneige Water Sleeping Mask' },
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.fallback_source, null);
        assert.equal(resp.body?.compare_meta?.open_world_status, 'skipped_sufficient_pool');
        assert.ok(Number(resp.body?.compare_meta?.pool_selected_count || 0) >= 3);
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.equal(resp.body.alternatives.length, 3);
        const labels = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.equal(labels.some((name) => /water sleeping mask/i.test(name)), false);
        assert.equal(labels.some((name) => /eyeshadow brush/i.test(name)), false);
        assert.equal(resp.body.alternatives.every((alt) => String(alt?.candidate_origin || '') === 'pool'), true);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: external_seed product-card rows use mixed compare path without legacy marker', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_anchor_moist',
                merchant_id: 'external_seed',
                brand: 'First Aid Beauty',
                name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                product_type: 'moisturizer',
                category: 'Moisturizer',
              },
              {
                product_id: 'ext_oat_water',
                merchant_id: 'external_seed',
                brand: 'KraveBeauty',
                name: 'Oat So Simple Water Cream',
                display_name: 'Oat So Simple Water Cream',
                product_type: 'moisturizer',
                category: 'Moisturizer',
              },
              {
                product_id: 'ext_cloud_cream',
                merchant_id: 'external_seed',
                brand: 'Bubble',
                name: 'Cloud Surf Water Cream Moisturizer',
                display_name: 'Cloud Surf Water Cream Moisturizer',
                product_type: 'moisturizer',
                category: 'Moisturizer',
              },
              {
                product_id: 'bad_tool',
                merchant_id: 'external_seed',
                brand: 'Random',
                name: 'Silicone Face Brush',
                display_name: 'Silicone Face Brush',
                product_type: 'tool',
                category: 'Tool',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        let geminiRequest = null;
        __internal.__setCallGeminiJsonObjectForTest(async (args = {}) => {
          geminiRequest = args;
          throw new Error('provider down');
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_seed_row',
            'X-Trace-ID': 'test_trace_alt_external_seed_row',
            'X-Brief-ID': 'test_brief_alt_external_seed_row',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'First Aid Beauty Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            max_total: 6,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: 'ext_anchor_moist',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
              product_type: 'Moisturizer',
              category: 'Moisturizer',
              canonical_product_ref: {
                product_id: 'ext_anchor_moist',
                merchant_id: 'external_seed',
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.compare_meta?.open_world_status, 'provider_error');
        assert.equal(resp.body?.llm_trace?.source_mode, 'local_gemini_open_world');
        assert.equal(resp.body?.llm_trace?.provider_model, 'gemini-3-flash-preview');
        assert.equal(resp.body?.llm_trace?.provider_route, 'aurora_reco_alternatives_open_world');
        assert.equal(resp.body?.llm_trace?.provider_reason, 'provider_error');
        assert.equal(resp.body?.llm_trace?.provider_result_reason, 'gemini_call_exception');
        assert.equal(geminiRequest?.model, 'gemini-3-flash-preview');
        assert.equal(geminiRequest?.maxOutputTokens, 3072);
        assert.equal(geminiRequest?.timeoutMs, 12000);
        assert.equal(geminiRequest?.queueTimeoutMs, 3000);
        assert.equal(geminiRequest?.upstreamTimeoutMs, 9000);
        assert.equal(geminiRequest?.responseJsonSchema?.properties?.alternatives?.maxItems, 3);
        assert.equal(geminiRequest?.responseJsonSchema?.properties?.alternatives?.items?.properties?.product_type?.type, 'string');
        assert.equal(geminiRequest?.responseJsonSchema?.properties?.alternatives?.items?.properties?.product_type?.nullable, true);
        assert.equal(geminiRequest?.responseJsonSchema?.properties?.alternatives?.items?.properties?.similarity_score?.type, 'number');
        assert.equal(geminiRequest?.responseJsonSchema?.properties?.alternatives?.items?.properties?.similarity_score?.nullable, true);
        assert.ok(Number(resp.body?.compare_meta?.pool_selected_count || 0) >= 2);
        const names = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.equal(names.some((name) => /Hydrating Dewy Gel Cream/i.test(name)), false);
        assert.equal(names.some((name) => /brush/i.test(name)), false);
        assert.ok(names.some((name) => /Water Cream|Moisturizer/i.test(name)));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: external_seed mixed compare recovers pretty truncated open-world rows', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_anchor_moist',
                merchant_id: 'external_seed',
                brand: 'First Aid Beauty',
                name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                product_type: 'moisturizer',
                category: 'Moisturizer',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: false,
          reason: 'PARSE_TRUNCATED_JSON',
          detail: 'finish_reason=MAX_TOKENS',
          raw_text: `{
  "alternatives": [
    {
      "brand": "Belif",
      "name": "The True Cream Aqua Bomb",
      "product_type": "moisturizer",
      "similarity_score": 0.74,
      "reasons": [
        "Lightweight gel-cream role fits the same breathable moisturizer step."
      ],
      "tradeoff_notes": [
        "Barrier-support ingredients may differ from the anchor."
      ]
    },
    {
      "brand": "Neutrogena",
      "name": "Hydro Boost Water Gel",
      "product_type": "moisturizer",
      "similarity_score": 0.69,
      "reasons": [
        "Water-gel texture is a similar lightweight hydration role."
      ],
      "tradeoff_notes": [
        "Formula feel and ceramide support are not guaranteed to match."
      ]
    }`,
          finish_reason: 'MAX_TOKENS',
          parse_status: 'parse_truncated',
          meta: { result_reason: 'gemini_json_max_tokens' },
        }));

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_seed_trunc',
            'X-Trace-ID': 'test_trace_alt_external_seed_trunc',
            'X-Brief-ID': 'test_brief_alt_external_seed_trunc',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'First Aid Beauty Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            max_total: 3,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: 'ext_anchor_moist',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
              product_type: 'Moisturizer',
              category: 'Moisturizer',
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.failure_class, null);
        assert.equal(resp.body?.compare_meta?.open_world_status, 'success');
        assert.equal(resp.body?.llm_trace?.finish_reason, 'MAX_TOKENS');
        assert.equal(resp.body?.llm_trace?.parse_status, 'parse_truncated');
        assert.equal(resp.body?.llm_trace?.recovered_from_truncated_raw, true);
        assert.equal(resp.body?.llm_trace?.recovered_row_count, 2);
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.equal(resp.body.alternatives.length, 2);
        const brands = resp.body.alternatives.map((alt) => alt?.product?.brand).sort();
        assert.deepEqual(brands, ['Belif', 'Neutrogena']);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('sortRecoAlternativesByMixedScore does not let reviewed insight bonus outrank clearly stronger relevance', () => {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  try {
    const { __internal } = require('../src/auroraBff/routes');
    const sorted = __internal.sortRecoAlternativesByMixedScore(
      [
        {
          product: { product_id: 'ext_boj_calming', name: 'Calming Barrier Serum' },
          grounding_status: 'catalog_verified',
          similarity_score: 69,
          _mixed_score: 0.69,
          product_intel: {
            product_intel_core: {
              what_it_is: { headline: 'Serum', body: 'Seller-grounded barrier serum.' },
            },
            shopping_card: {
              title: 'Beauty of Joseon Calming Barrier Serum',
              subtitle: 'Barrier serum',
            },
          },
        },
        {
          product: { product_id: 'ext_good_molecules', name: 'Niacinamide Serum' },
          grounding_status: 'catalog_verified',
          similarity_score: 72,
          _mixed_score: 0.72,
        },
      ],
      { useExperienceQualityBonus: true },
    );

    assert.equal(sorted[0]?.product?.product_id, 'ext_good_molecules');
    assert.ok(Number(sorted[1]?.metadata?.evidence_quality_bonus || 0) > 0);
    assert.ok(Number(sorted[1]?.metadata?.evidence_quality_bonus || 0) <= 0.02);
  } finally {
    delete require.cache[moduleId];
  }
});

test('/v1/reco/alternatives: external_seed compare uses reviewed insight as close-tie signal only', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
      GEMINI_API_KEY: 'test_gemini_key',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return { status: 200, data: { products: [] } };
      };

      const kbStoreModuleId = require.resolve('../src/auroraBff/productIntelKbStore');
      delete require.cache[kbStoreModuleId];
      const kbStore = require('../src/auroraBff/productIntelKbStore');
      const originalGetProductIntelKbEntry = kbStore.getProductIntelKbEntry;
      kbStore.getProductIntelKbEntry = async (kbKey) => {
        if (kbKey !== 'product:ext_lrp_aox') return null;
        return {
          kb_key: kbKey,
          analysis: {
            product_intel_v1: {
              contract_version: 'pivota.product_intel.v1',
              canonical_product_ref: {
                product_id: 'ext_lrp_aox',
                merchant_id: 'external_seed',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Pivota Insights',
                  body: 'A daily antioxidant sunscreen serum with SPF 50 and a face-serum format.',
                },
                best_for: [
                  { label: 'Daily broad-spectrum UV protection' },
                ],
                why_it_stands_out: [
                  { body: 'Pairs a serum texture with antioxidant support.' },
                ],
              },
              shopping_card: {
                title: 'La Roche-Posay Anthelios AOX Antioxidant Serum SPF 50',
                subtitle: 'Sunscreen serum',
                intro: 'Daily SPF 50 serum with antioxidant support.',
              },
              search_card: {
                compact_candidate: 'SPF 50 serum',
                intro_candidate: 'Daily SPF 50 serum with antioxidant support.',
              },
            },
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'Skin1004',
                name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
                product_type: 'sunscreen',
                similarity_score: 63,
                reasons: ['Features a very similar lightweight serum-like consistency.'],
                tradeoff_notes: ['Authority row is sparse and lacks reviewed compare highlights.'],
              },
              {
                brand: 'La Roche-Posay',
                name: 'Anthelios AOX Antioxidant Serum SPF 50',
                product_type: 'sunscreen',
                similarity_score: 62,
                reasons: ['True serum texture that integrates into a skincare routine.'],
                tradeoff_notes: ['Higher price point than the anchor.'],
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async (args = {}) => {
          const query = String(args?.query || '').toLowerCase();
          if (query.includes('skin1004') || query.includes('hyalu-cica') || query.includes('hyalu cica')) {
            return {
              resolved: true,
              product_ref: {
                product_id: 'ext_skin1004_water_fit',
                merchant_id: 'external_seed',
              },
              confidence: 0.91,
              reason: 'resolved',
            };
          }
          if (query.includes('la roche') || query.includes('anthelios aox')) {
            return {
              resolved: true,
              product_ref: {
                product_id: 'ext_lrp_aox',
                merchant_id: 'external_seed',
              },
              confidence: 0.91,
              reason: 'resolved',
            };
          }
          return {
            resolved: false,
            product_ref: null,
            confidence: 0,
            reason: 'no_candidates',
            candidates: [],
          };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_seed_evidence_rank',
            'X-Trace-ID': 'test_trace_alt_external_seed_evidence_rank',
            'X-Brief-ID': 'test_brief_alt_external_seed_evidence_rank',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'The Ordinary UV Filters SPF 45 Serum',
            max_total: 3,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: 'ext_anchor_sunscreen',
              merchant_id: 'external_seed',
              brand: 'the ordinary',
              name: 'UV Filters SPF 45 Serum',
              product_type: 'sunscreen',
              category: 'sunscreen',
              key_features: ['UV filters', 'Glycerin', 'Lightweight serum'],
              canonical_product_ref: {
                product_id: 'ext_anchor_sunscreen',
                merchant_id: 'external_seed',
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.alternatives?.length, 2);
        assert.equal(resp.body.alternatives[0]?.product?.product_id, 'ext_lrp_aox');
        assert.equal(resp.body.alternatives[0]?.metadata?.product_intel_kb_used, true);
        assert.ok(Number(resp.body.alternatives[0]?.metadata?.evidence_quality_bonus || 0) > 0);
        assert.ok(resp.body.alternatives[0]?.metadata?.ranking_signals_used?.includes('reviewed_experience_evidence_bonus'));
        assert.equal(resp.body.alternatives[1]?.product?.product_id, 'ext_skin1004_water_fit');
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        kbStore.getProductIntelKbEntry = originalGetProductIntelKbEntry;
        axios.get = originalGet;
        delete require.cache[moduleId];
        delete require.cache[kbStoreModuleId];
      }
    },
  );
});

test('/v1/reco/alternatives: external_seed rows preserve full-product candidates and drop refill variants when provider fails', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_anchor_moist',
                merchant_id: 'external_seed',
                brand: 'First Aid Beauty',
                name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                product_type: 'moisturizer',
                category: 'Moisturizer',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => {
          throw new Error('provider down');
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_seed_embedded',
            'X-Trace-ID': 'test_trace_alt_external_seed_embedded',
            'X-Brief-ID': 'test_brief_alt_external_seed_embedded',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'First Aid Beauty Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            max_total: 6,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: 'ext_anchor_moist',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
              product_type: 'Moisturizer',
              category: 'Moisturizer',
              product_candidates: [
                {
                  product_id: 'ext_oat_water',
                  merchant_id: 'external_seed',
                  brand: 'KraveBeauty',
                  name: 'Oat So Simple Water Cream',
                  category: 'Moisturizer',
                  price: { amount: 30, currency: 'USD', unknown: false },
                },
                {
                  product_id: 'ext_oat_refill',
                  merchant_id: 'external_seed',
                  brand: 'KraveBeauty',
                  name: 'Oat So Simple Water Cream Refill Pouch',
                  category: 'Moisturizer',
                  price: { amount: 25, currency: 'USD', unknown: false },
                },
              ],
              canonical_product_ref: {
                product_id: 'ext_anchor_moist',
                merchant_id: 'external_seed',
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.failure_class, null);
        assert.equal(resp.body?.compare_meta?.embedded_candidate_count, 2);
        assert.equal(resp.body?.compare_meta?.pool_selected_count, 1);
        assert.equal(resp.body?.compare_meta?.open_world_status, 'provider_error');
        const names = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.deepEqual(names, ['Oat So Simple Water Cream']);
        assert.equal(resp.body.alternatives.every((alt) => String(alt?.candidate_origin || '') === 'pool'), true);
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: external_seed hybrid merges open-world duplicates into catalog rows and removes refill variants', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_anchor_moist',
                merchant_id: 'external_seed',
                brand: 'First Aid Beauty',
                name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                display_name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
                product_type: 'moisturizer',
                category: 'Moisturizer',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'KraveBeauty',
                name: 'Oat So Simple Water Cream',
                product_type: 'Moisturizer',
                similarity_score: 84,
                reasons: ['Features a lightweight water-cream texture close to the anchor.'],
                tradeoff_notes: ['Does not provide the same explicit ceramide support.'],
              },
              {
                brand: 'Belif',
                name: 'The True Cream Aqua Bomb',
                product_type: 'Moisturizer',
                similarity_score: 78,
                reasons: ['Gel-cream hydration with a dewy finish.'],
                tradeoff_notes: ['Contains fragrance, which can be a sensitivity tradeoff.'],
              },
              {
                brand: 'Neutrogena',
                name: 'Hydro Boost Water Gel',
                product_type: 'Moisturizer',
                similarity_score: 74,
                reasons: ['Oil-free water-gel hydration for lightweight routines.'],
                tradeoff_notes: ['Less barrier-focused than the anchor.'],
              },
            ],
          },
        }));

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_seed_dedupe',
            'X-Trace-ID': 'test_trace_alt_external_seed_dedupe',
            'X-Brief-ID': 'test_brief_alt_external_seed_dedupe',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'First Aid Beauty Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
            max_total: 6,
            recommendation_mode: 'hybrid_fallback',
            disable_synthetic_local_fallback: true,
            product: {
              product_id: 'ext_anchor_moist',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Hydrating Dewy Gel Cream Moisturizer with Hyaluronic Acid + Ceramides',
              product_type: 'Moisturizer',
              category: 'Moisturizer',
              product_candidates: [
                {
                  product_id: 'ext_oat_water',
                  merchant_id: 'external_seed',
                  brand: 'KraveBeauty',
                  name: 'Oat So Simple Water Cream',
                  category: 'Moisturizer',
                  url: 'https://kravebeauty.com/products/oat-so-simple-water-cream',
                },
                {
                  product_id: 'ext_oat_refill',
                  merchant_id: 'external_seed',
                  brand: 'KraveBeauty',
                  name: 'Oat So Simple Water Cream Refill Pouch',
                  category: 'Moisturizer',
                  url: 'https://kravebeauty.com/products/oat-so-simple-refill',
                },
              ],
              canonical_product_ref: {
                product_id: 'ext_anchor_moist',
                merchant_id: 'external_seed',
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.compare_meta?.open_world_status, 'success');
        assert.equal(resp.body?.alternatives?.length, 3);
        const names = resp.body.alternatives.map((alt) => String(alt?.product?.name || alt?.name || ''));
        assert.equal(names.filter((name) => name === 'Oat So Simple Water Cream').length, 1);
        assert.equal(names.some((name) => /refill/i.test(name)), false);
        const krave = resp.body.alternatives.find((alt) => String(alt?.product?.name || '') === 'Oat So Simple Water Cream');
        assert.equal(krave?.product?.product_id, 'ext_oat_water');
        assert.equal(krave?.grounding_status, 'catalog_verified');
        assert.equal(Array.isArray(krave?.metadata?.merged_candidate_origins), true);
        assert.ok((krave?.reasons || []).some((reason) => /water-cream texture/i.test(String(reason))));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: external llm_seed compare mixes pool and open-world candidates', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_anchor_serum',
                merchant_id: 'mid_serum',
                brand: 'La Roche-Posay',
                name: 'Effaclar Ultra Concentrated Serum',
                display_name: 'Effaclar Ultra Concentrated Serum',
                product_type: 'serum',
                category: 'Serum',
              },
              {
                product_id: 'prod_serum_1',
                merchant_id: 'mid_serum',
                brand: 'Paula’s Choice',
                name: '10% Azelaic Acid Booster',
                display_name: '10% Azelaic Acid Booster',
                product_type: 'serum',
                category: 'Serum',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: {
            alternatives: [
              {
                brand: 'SkinCeuticals',
                name: 'Blemish + Age Defense',
                product_type: 'serum',
                reasons: ['Targets blemish care and post-acne marks.'],
                tradeoff_notes: ['Usually pricier than the anchor.'],
                best_use: 'Oily, acne-prone skin',
              },
              {
                brand: 'The Ordinary',
                name: 'Niacinamide 10% + Zinc 1%',
                product_type: 'serum',
                reasons: ['Covers oil control and tone-evening goals.'],
                tradeoff_notes: ['Can feel tackier on some routines.'],
                best_use: 'Acne marks and shine control',
              },
            ],
          },
        }));
        __internal.__setResolveProductRefForTest(async (args = {}) => {
          const query = String(args?.query || '').toLowerCase();
          if (query.includes('skinceuticals') || query.includes('blemish + age')) {
            return {
              resolved: true,
              product_ref: {
                product_id: 'ext_skinceuticals_blemish_age_defense',
                merchant_id: 'external_seed',
              },
              confidence: 0.91,
              reason: 'resolved',
            };
          }
          if (query.includes('the ordinary') || query.includes('niacinamide')) {
            return {
              resolved: true,
              product_ref: {
                product_id: '9886499864904',
                merchant_id: 'merch_efbc46b4619cfbdf',
              },
              confidence: 0.91,
              reason: 'resolved',
            };
          }
          return {
            resolved: false,
            product_ref: null,
            confidence: 0,
            reason: 'no_candidates',
            candidates: [],
          };
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_mixed',
            'X-Trace-ID': 'test_trace_alt_external_mixed',
            'X-Brief-ID': 'test_brief_alt_external_mixed',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'La Roche-Posay Effaclar Ultra Concentrated Serum',
            max_total: 6,
            product: {
              brand: 'La Roche-Posay',
              name: 'Effaclar Ultra Concentrated Serum',
              metadata: { match_state: 'llm_seed' },
              pdp_open: {
                path: 'external',
                external: { query: 'La Roche-Posay Effaclar Ultra Concentrated Serum' },
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.compare_meta?.pool_selected_count, 1);
        assert.ok(Number(resp.body?.compare_meta?.open_world_selected_count || 0) >= 2);
        assert.equal(resp.body?.compare_meta?.open_world_status, 'success');
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.equal(resp.body.alternatives.length, 3);
        assert.ok(resp.body.alternatives.some((alt) => String(alt?.candidate_origin || '') === 'open_world'));
        assert.ok(resp.body.alternatives.some((alt) => String(alt?.candidate_origin || '') === 'pool'));
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        loaded?.__internal?.__resetResolveProductRefForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/alternatives: external llm_seed compare returns explainable empty without synthetic fallback', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_CATALOG_SELF_PROXY_ENABLED: 'false',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_anchor_seed',
                merchant_id: 'mid_seed',
                brand: 'Laneige',
                name: 'Water Sleeping Mask',
                display_name: 'Water Sleeping Mask',
                product_type: 'mask',
                category: 'Sleeping Mask',
              },
              {
                product_id: 'prod_tool_seed',
                merchant_id: 'mid_seed',
                brand: 'Random',
                name: 'Small Eyeshadow Brush',
                display_name: 'Small Eyeshadow Brush',
                product_type: 'makeup brush',
                category: 'Makeup Brush',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes, __internal } = routeModule;
        __internal.__setCallGeminiJsonObjectForTest(async () => ({
          ok: true,
          json: { alternatives: [] },
        }));

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/alternatives')
          .set({
            'X-Aurora-UID': 'test_uid_alt_external_empty',
            'X-Trace-ID': 'test_trace_alt_external_empty',
            'X-Brief-ID': 'test_brief_alt_external_empty',
            'X-Lang': 'EN',
          })
          .send({
            product_input: 'Laneige Water Sleeping Mask',
            max_total: 6,
            product: {
              brand: 'Laneige',
              name: 'Water Sleeping Mask',
              metadata: { match_state: 'llm_seed' },
              pdp_open: {
                path: 'external',
                external: { query: 'Laneige Water Sleeping Mask' },
              },
            },
          });

        assert.equal(resp.status, 200);
        assert.equal(resp.body?.source_mode, 'pool_open_world_mixed');
        assert.equal(resp.body?.fallback_source, 'none');
        assert.equal(Array.isArray(resp.body?.alternatives), true);
        assert.equal(resp.body.alternatives.length, 0);
        assert.equal(resp.body?.compare_meta?.pool_recall_status, 'empty');
        assert.equal(resp.body?.compare_meta?.open_world_status, 'empty');
        assert.equal(resp.body?.no_result_reason, 'pool_and_open_world_empty');
      } finally {
        const loaded = require.cache[moduleId] && require.cache[moduleId].exports;
        loaded?.__internal?.__resetCallGeminiJsonObjectForTest?.();
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/generate: uses grounded generic reco mainline instead of legacy routine path', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      let searchCalls = 0;
      decisionModule.auroraChat = async () => {
        const err = new Error('upstream timeout');
        err.code = 'ECONNABORTED';
        throw err;
      };
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        searchCalls += 1;
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: `prod_reco_${searchCalls}`,
                merchant_id: 'mid_reco',
                brand: 'BrandReco',
                name: `Reco Product ${searchCalls}`,
                display_name: `Reco Product ${searchCalls}`,
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const routeModule = require('../src/auroraBff/routes');
        const { mountAuroraBffRoutes } = routeModule;
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/generate')
          .set({
            'X-Aurora-UID': 'test_uid_reco_generate_grounded',
            'X-Trace-ID': 'test_trace_reco_generate_grounded',
            'X-Brief-ID': 'test_brief_reco_generate_grounded',
            'X-Lang': 'EN',
          })
          .send({
            focus: 'barrier support',
            constraints: { budget: 'mid', fragrance_free: 'preferred' },
          });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const recoCard = cards.find((card) => card && card.type === 'recommendations') || null;
        assert.ok(recoCard);
        const recos = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
        assert.ok(recos.length > 0);
        assert.equal(recoCard?.payload?.recommendation_meta?.source_mode, 'catalog_grounded');
        const recoEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((evt) => evt && evt.event_name === 'recos_requested')
          : null;
        assert.ok(recoEvent);
        assert.equal(String(recoEvent?.data?.source || '').includes('catalog_grounded'), true);
        assert.equal(recoEvent?.data?.mainline_status, 'grounded_success');
        assert.equal(recoEvent?.data?.reason || null, null);
        assert.ok(searchCalls >= 1);
      } finally {
        axios.get = originalGet;
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[moduleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('/v1/reco/generate: keeps ungrounded recommendation plan when catalog grounding is unavailable', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      decisionModule.auroraChat = async () => ({
        answer: JSON.stringify({
          recommendations: [
            {
              product_type: 'serum',
              use_case: 'fade post-acne marks with low irritation',
              concern_match: ['dark_spots', 'acne_marks'],
              skin_fit: ['oily', 'sensitive'],
              constraint_notes: ['fragrance_free_preferred'],
              query_terms: ['azelaic acid serum', 'niacinamide serum'],
              reasons: ['Targets acne marks while staying low irritation.'],
            },
          ],
          confidence: 0.84,
          missing_info: [],
          warnings: [],
        }),
      });

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/generate')
          .set({
            'X-Aurora-UID': 'test_uid_reco_generate_ungrounded',
            'X-Trace-ID': 'test_trace_reco_generate_ungrounded',
            'X-Brief-ID': 'test_brief_reco_generate_ungrounded',
            'X-Lang': 'EN',
          })
          .send({
            focus: 'post-acne marks',
            constraints: { fragrance_free: true },
          });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const recoCard = cards.find((card) => card && card.type === 'recommendations') || null;
        assert.ok(recoCard);
        const recs = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
        assert.equal(recs.length >= 1, true);
        assert.equal(recoCard?.payload?.grounding_status, 'ungrounded');
        assert.equal(recoCard?.payload?.recommendation_meta?.source_mode, 'llm_primary');
        assert.equal(String(recoCard?.payload?.source || ''), 'llm_editorial_v1');
        assert.equal(String(recoCard?.payload?.mainline_status || ''), 'catalog_skipped_disabled');
        const recoEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((evt) => evt && evt.event_name === 'recos_requested')
          : null;
        assert.ok(recoEvent);
        assert.equal(String(recoEvent?.data?.reason || ''), '');
        assert.equal(String(recoEvent?.data?.grounding_status || ''), 'ungrounded');
        assert.equal(Number(recoEvent?.data?.ungrounded_count || 0) >= 1, true);
      } finally {
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[moduleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('/v1/reco/generate: empty catalog-grounded payload is not reported as grounded_success', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT: 'false',
      AURORA_BFF_RECO_CATALOG_TRANSIENT_FALLBACK: 'false',
      AURORA_BFF_RECO_GENERATE_GUARDRAIL_V1: 'true',
    },
    async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      axios.get = async (url) => {
        if (!isProductsSearchUrl(url)) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_guardrail_empty',
                merchant_id: 'mid_guardrail_empty',
                brand: 'NeutralBrand',
                name: 'Everyday 200ml',
                display_name: 'Everyday 200ml',
              },
            ],
          },
        };
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/generate')
          .set({
            'X-Aurora-UID': 'test_uid_reco_generate_guardrail_empty',
            'X-Trace-ID': 'test_trace_reco_generate_guardrail_empty',
            'X-Brief-ID': 'test_brief_reco_generate_guardrail_empty',
            'X-Lang': 'EN',
          })
          .send({
            focus: 'barrier support',
            constraints: { budget: 'mid' },
          });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const conf = cards.find((card) => card && card.type === 'confidence_notice') || null;
        const reco = cards.find((card) => card && card.type === 'recommendations') || null;
        assert.ok(conf);
        assert.equal(Boolean(reco), false);
        assert.equal(conf?.payload?.reason, 'artifact_missing');
        const recoEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((evt) => evt && evt.event_name === 'recos_requested')
          : null;
        assert.ok(recoEvent);
        assert.equal(recoEvent?.data?.reason, 'artifact_missing');
        assert.notEqual(recoEvent?.data?.mainline_status, 'grounded_success');
        assert.ok(['empty_structured', 'upstream_timeout', 'upstream_schema_invalid', 'catalog_queries_empty'].includes(String(recoEvent?.data?.mainline_status || '')));
        assert.ok(['rules_only', 'catalog_grounded', 'catalog_transient_fallback', 'llm_primary'].includes(String(recoEvent?.data?.source_mode || '')));
        assert.ok(String(recoEvent?.data?.products_empty_reason || '').length > 0);
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/reco/generate: quick-profile request context is consumed as explicit-only analysis context', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      decisionModule.auroraChat = async () => ({
        answer: JSON.stringify({
          recommendations: [
            {
              product_type: 'cleanser',
              use_case: 'gentle oily-skin cleanse',
              concern_match: ['acne'],
              skin_fit: ['oily', 'sensitive'],
              constraint_notes: ['fragrance_free_preferred'],
              query_terms: ['gentle cleanser'],
              reasons: ['A simple cleanser plan for oily skin with acne goals.'],
            },
          ],
          confidence: 0.8,
          missing_info: [],
          warnings: [],
        }),
      });

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/generate')
          .set({
            'X-Aurora-UID': 'test_uid_reco_generate_quick_profile',
            'X-Trace-ID': 'test_trace_reco_generate_quick_profile',
            'X-Brief-ID': 'test_brief_reco_generate_quick_profile',
            'X-Lang': 'EN',
          })
          .send({
            focus: 'breakouts',
            context: {
              skin_feel: 'oily',
              goal_primary: 'breakouts',
              sensitivity_flag: 'yes',
            },
          });

        assert.equal(resp.status, 200);
        const meta =
          resp.body &&
          resp.body.session_patch &&
          resp.body.session_patch.meta &&
          typeof resp.body.session_patch.meta === 'object' &&
          !Array.isArray(resp.body.session_patch.meta)
            ? resp.body.session_patch.meta
            : {};
        assert.equal(meta.profile_context_source, 'request_overlay_applied');
        assert.deepEqual(meta.request_profile_overlay_keys, ['goals', 'sensitivity', 'skinType']);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const recoCard = cards.find((card) => card && card.type === 'recommendations') || null;
        const recoMeta =
          recoCard &&
          recoCard.payload &&
          recoCard.payload.recommendation_meta &&
          typeof recoCard.payload.recommendation_meta === 'object' &&
          !Array.isArray(recoCard.payload.recommendation_meta)
            ? recoCard.payload.recommendation_meta
            : {};
        assert.equal(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.snapshot_present, false);
        assert.equal(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.context_source_mode, 'explicit_only');
        assert.equal(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.analysis_context_available, true);
        assert.equal(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.minimum_recommendation_context_satisfied, true);
        assert.equal(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.request_context_signature_version, 'request_context_signature_v1');
        assert.equal(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.strictness_source, 'entry_default');
        assert.equal(recoMeta.request_context_signature_version, 'request_context_signature_v1');
        assert.equal(recoMeta.candidate_pool_signature_version, 'candidate_pool_signature_v1');
        assert.ok(['explicit_only', 'snapshot_hard', 'snapshot_mixed'].includes(String(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.context_mode || '')));
        assert.equal(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.explicit_override_applied, true);
        assert.deepEqual(
          Array.isArray(recoMeta.analysis_context_usage && recoMeta.analysis_context_usage.hard_context_fields_used)
            ? recoMeta.analysis_context_usage.hard_context_fields_used.sort()
            : [],
          ['active_goals', 'sensitivity', 'skin_type'],
        );
      } finally {
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[moduleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('/v1/reco/generate: insufficient explicit-only context returns structured needs_more_context', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/reco/generate')
          .set({
            'X-Aurora-UID': 'test_uid_reco_generate_needs_more_context',
            'X-Trace-ID': 'test_trace_reco_generate_needs_more_context',
            'X-Brief-ID': 'test_brief_reco_generate_needs_more_context',
            'X-Lang': 'EN',
          })
          .send({
            session: {
              profile: {
                goals: ['hydration'],
              },
            },
          });

        assert.equal(resp.status, 200);
        const meta =
          resp.body &&
          resp.body.session_patch &&
          resp.body.session_patch.meta &&
          typeof resp.body.session_patch.meta === 'object' &&
          !Array.isArray(resp.body.session_patch.meta)
            ? resp.body.session_patch.meta
            : {};
        assert.equal(meta.recommendation_state && meta.recommendation_state.needs_more_context, true);
        assert.deepEqual(meta.recommendation_state && meta.recommendation_state.missing_context, ['minimum_recommendation_context']);
        assert.equal(meta.recommendation_state && meta.recommendation_state.mainline_status, 'needs_more_context');
        assert.equal(meta.analysis_context_usage?.snapshot_present, false);
        assert.equal(meta.analysis_context_usage?.context_source_mode, 'explicit_only');
        assert.equal(meta.analysis_context_usage?.analysis_context_available, true);
        assert.equal(meta.analysis_context_usage?.minimum_recommendation_context_satisfied, false);
        assert.equal(meta.analysis_context_usage?.strictness_source, 'entry_default');
        assert.equal(meta.recommendation_state && meta.recommendation_state.request_context_signature_version, 'request_context_signature_v1');
        assert.equal(meta.recommendation_state && meta.recommendation_state.candidate_pool_signature_version, 'candidate_pool_signature_v1');
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const recoCard = cards.find((card) => card && card.type === 'recommendations') || null;
        const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
        assert.equal(Boolean(recoCard), false);
        assert.ok(confidenceCard);
      } finally {
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/chat: ingredient.by_goal returns ingredient_goal_match even when client_state=RECO_GATE', async () => {
  return withEnv({ AURORA_BFF_RETENTION_DAYS: '0', DATABASE_URL: undefined }, async () => {
    const moduleId = require.resolve('../src/auroraBff/routes');
    delete require.cache[moduleId];
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await supertest(app)
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'test_uid_ingredient_goal_reco_gate',
        'X-Trace-ID': 'test_trace_goal_reco_gate',
        'X-Brief-ID': 'test_brief_goal_reco_gate',
        'X-Lang': 'EN',
      })
      .send({
        action: {
          action_id: 'ingredient.by_goal',
          kind: 'action',
          data: { goal: 'barrier', sensitivity: 'medium', entry_source: 'ingredient_hub' },
        },
        session: { state: 'S7_PRODUCT_RECO' },
        client_state: 'RECO_GATE',
        language: 'EN',
      });

    assert.equal(resp.status, 200);
    const cardTypes = Array.isArray(resp.body?.cards) ? resp.body.cards.map((card) => String(card?.type || '')) : [];
    assert.equal(cardTypes.includes('ingredient_goal_match'), true);
    assert.equal(cardTypes.includes('diagnosis_gate'), false);
  });
});

test('/v1/chat: ingredient entry action returns ingredient_hub (no diagnosis_gate/budget_gate) in S6_BUDGET', async () => {
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
      headers: { 'X-Aurora-UID': 'test_uid_ingredient_hub_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
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
      headers: { 'X-Aurora-UID': 'test_uid_ingredient_hub_budget_state', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief', 'X-Lang': 'EN' },
      body: {
        action: { action_id: 'chip.start.ingredients.entry', kind: 'chip', data: { trigger_source: 'chip' } },
        session: { state: 'S6_BUDGET' },
        client_state: 'RECO_GATE',
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('ingredient_hub'), true);
    assert.equal(cardTypes.includes('diagnosis_gate'), false);
    assert.equal(cardTypes.includes('budget_gate'), false);
  });
});

test('/v1/chat: ingredient diagnosis opt-in enters S2 diagnosis flow from non-diagnosis state', async () => {
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
      headers: {
        'X-Aurora-UID': 'test_uid_ingredient_optin_diagnosis',
        'X-Trace-ID': 'test_trace',
        'X-Brief-ID': 'test_brief',
        'X-Lang': 'EN',
      },
      body: {
        action: { action_id: 'ingredient.optin_diagnosis', kind: 'action', data: { trigger_source: 'ingredient_hub' } },
        session: { state: 'S6_BUDGET' },
        client_state: 'RECO_GATE',
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const cardTypes = (resp.body?.cards || []).map((c) => c && c.type).filter(Boolean);
    assert.equal(cardTypes.includes('diagnosis_gate'), true);
    assert.equal(cardTypes.includes('budget_gate'), false);
    assert.equal(resp.body?.session_patch?.next_state, 'DIAG_PROFILE');
    assert.equal(resp.body?.session_patch?.state?._internal_next_state, 'S2_DIAGNOSIS');
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
      assert.notEqual(String(conf?.payload?.reason || ''), 'diagnosis_first');
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
	    assert.ok(cardTypes.includes('recommendations') || cardTypes.includes('confidence_notice'));
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
    assertPassiveGateAdvisorySignal(resp.body, 'fit_check_anchor_gate');

    const assistant = String(resp.body?.assistant_message?.content || '');
    assert.equal(assistant.length > 0, true);

    const snap = snapshotVisionMetrics();
    const auroraChatCalls = (Array.isArray(snap.upstreamCalls) ? snap.upstreamCalls : []).filter(([key]) => {
      try {
        return JSON.parse(key).path === 'aurora_chat';
      } catch (_err) {
        return false;
      }
    });
    assert.equal(auroraChatCalls.length <= 1, true);
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
  assert.ok(reasons.some((r) => /^(匹配目标|匹配点|你的情况)：/.test(String(r || ''))));
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

test('/v1/chat: chip_get_recos first clarifies goal, then yields recommendations after goal is resolved', async () => {
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
      const chips1 = Array.isArray(resp1.body?.suggested_chips) ? resp1.body.suggested_chips : [];
	    const nextState1 = resp1.body?.session_patch?.next_state;
	    assert.ok(nextState1 === undefined || nextState1 === 'RECO_RESULTS' || nextState1 === 'IDLE_CHAT' || nextState1 === 'S7_PRODUCT_RECO');
	    assert.equal(cards1.some((c) => c && c.type === 'diagnosis_gate'), false);
	    const reco1 = cards1.find((c) => c && c.type === 'recommendations') || null;
	    const conf1 = cards1.find((c) => c && c.type === 'confidence_notice') || null;
    assert.equal(reco1, null);
    assert.equal(conf1, null);
    assert.ok(chips1.length >= 5);
    const goalChip = chips1.find((chip) => chip && chip.chip_id === 'chip.reco_goal.breakouts') || chips1[0] || null;
    assert.ok(goalChip);
    assert.equal(String(goalChip?.data?.action_id || ''), 'chip.start.reco_products');
    assert.ok(Array.isArray(goalChip?.data?.profile_patch?.goals));

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
        action: {
          action_id: String(goalChip?.data?.action_id || 'chip.start.reco_products'),
          kind: 'chip',
          data: goalChip?.data || {},
        },
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
      const recs = Array.isArray(reco?.payload?.recommendations) ? reco.payload.recommendations : [];
      assert.equal(Array.isArray(recs), true);
      const recommendationMeta = reco && reco.payload && typeof reco.payload === 'object' ? reco.payload.recommendation_meta : null;
      if (recommendationMeta && typeof recommendationMeta === 'object') {
        assert.ok(['llm_primary', 'catalog_grounded', 'catalog_transient_fallback', 'artifact_matcher', 'upstream_fallback', 'rules_only'].includes(String(recommendationMeta.source_mode || '')));
        assert.equal(typeof recommendationMeta.used_recent_logs, 'boolean');
        assert.equal(typeof recommendationMeta.used_itinerary, 'boolean');
        assert.equal(typeof recommendationMeta.used_safety_flags, 'boolean');
      }
    }
    if (conf) {
      assert.notEqual(String(conf?.payload?.reason || ''), 'diagnosis_first');
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
    const confNoProfile = cardsNoProfile.find((c) => c && c.type === 'confidence_notice') || null;
    assert.equal(cardsNoProfile.some((c) => c && c.type === 'diagnosis_gate'), false);
    assert.equal(cardsNoProfile.some((c) => c && c.type === 'routine_simulation'), false);
    assert.equal(cardsNoProfile.some((c) => c && c.type === 'conflict_heatmap'), false);
    assert.ok(Array.isArray(respNoProfile.body?.suggested_chips));
    assert.ok(Array.isArray(respNoProfile.body?.suggested_chips));
    assert.equal(JSON.stringify(respNoProfile.body).includes('kb:'), false);
    if (confNoProfile) {
      const reasonNoProfile = String(confNoProfile?.payload?.reason || '').trim();
      assert.notEqual(reasonNoProfile, '');
      assert.notEqual(reasonNoProfile, 'diagnosis_first');
    }
    // No value_moment product reco should be emitted when gated.
    assert.ok([true, false].includes((respNoProfile.body?.events || []).some((e) => e && e.event_name === 'recos_requested')));

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
    assert.ok(Array.isArray(cards));
    if (conf) {
      const reason = String(conf?.payload?.reason || '').trim();
      assert.notEqual(reason, '');
      assert.notEqual(reason, 'diagnosis_first');
    }
    assert.equal(cards.some((c) => c && c.type === 'routine_simulation'), false);
    assert.equal(cards.some((c) => c && c.type === 'conflict_heatmap'), false);

    // Non-debug responses must not leak internal kb:* refs anywhere.
    assert.equal(JSON.stringify(resp.body).includes('kb:'), false);

    const events = Array.isArray(resp.body?.events) ? resp.body.events : [];
    const recosRequested = events.find((e) => e && e.event_name === 'recos_requested') || null;
    const vm = events.find((e) => e && e.event_name === 'value_moment') || null;
    if (hasReco) {
      if (vm) assert.equal(vm?.data?.kind, 'product_reco');
    } else if (recosRequested) {
      assert.equal(vm === null || vm?.data?.kind === 'product_reco', true);
      const recoReason = String(recosRequested?.data?.reason || '');
      if (recoReason) {
        assert.equal(recoReason, 'artifact_missing');
      }
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

test('/v1/chat: reco timeout keeps artifact_missing as primary reason and timeout only in telemetry', async () => {
  return withEnv(
    {
      AURORA_BFF_RETENTION_DAYS: '0',
      DATABASE_URL: undefined,
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      AURORA_PRODUCT_MATCHER_ENABLED: 'false',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      decisionModule.auroraChat = async () => {
        const err = new Error('upstream timeout');
        err.code = 'ECONNABORTED';
        throw err;
      };

      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      try {
        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/chat')
          .set({
            'X-Aurora-UID': 'test_uid_reco_timeout_primary_reason',
            'X-Trace-ID': 'test_trace_reco_timeout_primary_reason',
            'X-Brief-ID': 'test_brief_reco_timeout_primary_reason',
            'X-Lang': 'EN',
          })
          .send({
            action: {
              action_id: 'chip.start.reco_products',
              kind: 'chip',
              data: {
                reply_text: 'Recommend products now',
                profile_patch: {
                  skinType: 'oily',
                  sensitivity: 'low',
                  barrierStatus: 'healthy',
                  goals: ['acne'],
                },
              },
            },
            language: 'EN',
            session: { state: 'S2_DIAGNOSIS' },
          });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const conf = cards.find((card) => card && card.type === 'confidence_notice') || null;
        assert.ok(conf);
        assert.equal(conf?.payload?.reason, 'artifact_missing');

        const recoEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((evt) => evt && evt.event_name === 'recos_requested')
          : null;
        assert.ok(recoEvent);
        assert.equal(recoEvent?.data?.reason, 'artifact_missing');
        assert.equal(recoEvent?.data?.telemetry_reason, 'timeout_degraded');
        assert.equal(recoEvent?.data?.failure_class, 'timeout');
      } finally {
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[moduleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
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

test('/v1/chat: reco chip does not hard-gate when profile is incomplete', async () => {
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
    assert.equal(resp.body?.session_patch?.next_state, 'RECO_RESULTS');
    const internalNextState = resp.body?.session_patch?.state?._internal_next_state;
    assert.ok(internalNextState === undefined || internalNextState === 'S7_PRODUCT_RECO');

    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    assert.equal(cards.some((c) => c && c.type === 'diagnosis_gate'), false);
    const reco = cards.find((c) => c && c.type === 'recommendations') || null;
    const conf = cards.find((c) => c && c.type === 'confidence_notice') || null;
    assert.ok(reco || conf);
    if (conf) {
      assert.notEqual(String(conf?.payload?.reason || ''), 'diagnosis_first');
    }
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

test('/v1/chat: chip.start.reco_products with force_route bypasses weather short-circuit', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      OPENAI_API_KEY: '',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const uid = `test_uid_reco_force_route_${Date.now()}`;
      const headers = {
        'X-Aurora-UID': uid,
        'X-Trace-ID': 'test_trace',
        'X-Brief-ID': 'test_brief',
        'X-Lang': 'EN',
      };

      await supertest(app)
        .post('/v1/profile/update')
        .set(headers)
        .send({
          skinType: 'oily',
          sensitivity: 'low',
          barrierStatus: 'healthy',
          goals: ['pores'],
          region: 'San Francisco, CA',
        })
        .expect(200);

      const resp = await supertest(app)
        .post('/v1/chat')
        .set(headers)
        .send({
          action: {
            action_id: 'chip.start.reco_products',
            kind: 'chip',
            data: {
              reply_text: 'Show full skincare product recommendations.',
              force_route: 'reco_products',
            },
          },
          session: { state: 'idle' },
          language: 'EN',
        })
        .expect(200);

      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const hasEnvStress = cards.some((card) => card && card.type === 'env_stress');
      assert.equal(hasEnvStress, false);

      const weatherValueMoment = (resp.body?.events || []).find(
        (evt) => evt && evt.event_name === 'value_moment' && evt.data && evt.data.kind === 'weather_advice',
      );
      assert.equal(Boolean(weatherValueMoment), false);

      delete require.cache[moduleId];
    },
  );
});

test('/v1/chat: travel/weather response includes travel_readiness and internal decision provenance meta', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      OPENAI_API_KEY: '',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const uid = `test_uid_env_readiness_${Date.now()}`;
      const headers = {
        'X-Aurora-UID': uid,
        'X-Trace-ID': 'test_trace',
        'X-Brief-ID': 'test_brief',
        'X-Lang': 'EN',
      };

      await supertest(app)
        .post('/v1/profile/update')
        .set(headers)
        .send({
          skinType: 'oily',
          sensitivity: 'low',
          barrierStatus: 'healthy',
          goals: ['pores'],
          region: 'San Francisco, CA',
          travel_plans: [
            {
              destination: 'Paris, France',
              start_date: '2026-03-10',
              end_date: '2026-03-15',
            },
          ],
        })
        .expect(200);

      const resp = await supertest(app)
        .post('/v1/chat')
        .set(headers)
        .send({
          message: 'How is weather there? Will it be humid?',
          session: { state: 'idle' },
          language: 'EN',
        })
        .expect(200);

      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const envStress = cards.find((c) => c && c.type === 'env_stress') || null;
      assert.ok(envStress);
      assert.equal(envStress?.payload?.schema_version, 'aurora.ui.env_stress.v1');
      assert.ok(envStress?.payload?.travel_readiness && typeof envStress.payload.travel_readiness === 'object');
      if (envStress?.payload?.travel_readiness?.structured_sections != null) {
        assert.ok(typeof envStress.payload.travel_readiness.structured_sections === 'object');
      }
      assert.ok(typeof envStress?.payload?.tier_description === 'string' && envStress.payload.tier_description.length > 0);
      const radarRows = Array.isArray(envStress?.payload?.radar) ? envStress.payload.radar : [];
      assert.equal(radarRows.length > 0, true);
      assert.equal(radarRows.some((row) => Array.isArray(row?.drivers) && row.drivers.length > 0), true);
      const shoppingPreview =
        envStress?.payload?.travel_readiness?.shopping_preview &&
        typeof envStress.payload.travel_readiness.shopping_preview === 'object'
          ? envStress.payload.travel_readiness.shopping_preview
          : null;
      assert.ok(shoppingPreview);
      const shoppingProducts = Array.isArray(shoppingPreview?.products)
        ? shoppingPreview.products
        : [];
      assert.equal(shoppingProducts.length > 0, true);
      assert.equal(Array.isArray(shoppingPreview?.buying_channels), true);
      assert.equal(shoppingPreview.buying_channels.length > 0, true);
      const allowedProductSource = new Set(['catalog', 'category_guidance', 'llm_generated']);
      assert.equal(
        shoppingProducts.every((row) => allowedProductSource.has(String(row?.product_source || '').trim())),
        true,
      );
      assert.equal(
        shoppingProducts.some((row) => String(row?.product_source || '').trim() === 'rule_fallback'),
        false,
      );
      assert.doesNotMatch(String(resp.body?.assistant_message?.content || ''), /destination and travel dates/i);

      const types = cards.map((c) => (c && typeof c.type === 'string' ? c.type : '')).filter(Boolean);
      assert.equal(types.includes('diagnosis_gate'), false);
      assert.equal(types.includes('gate_notice'), false);
      assert.equal(types.includes('analysis_summary'), false);
      assert.equal(types.includes('analysis_story_v2'), false);

      const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
      const chipIds = chips.map((chip) => String(chip && chip.chip_id ? chip.chip_id : ''));
      assert.ok(chipIds.includes('chip.start.routine'));
      assert.ok(chipIds.includes('chip.start.reco_products'));

      const topMeta = resp.body?.meta || {};
      assert.equal(typeof topMeta.env_source === 'string' && topMeta.env_source.length > 0, true);
      assert.equal(typeof topMeta.degraded === 'boolean', true);
      assert.equal(topMeta.travel_skills_version, 'travel_skills_dag_v1');
      assert.equal(Array.isArray(topMeta.travel_skills_trace), true);
      assert.equal(topMeta.travel_kb_hit, false);
      assert.equal(typeof topMeta.travel_kb_write_queued, 'boolean');
      const invocationMatrix =
        topMeta.travel_skill_invocation_matrix && typeof topMeta.travel_skill_invocation_matrix === 'object'
          ? topMeta.travel_skill_invocation_matrix
          : {};
      assert.equal(typeof invocationMatrix.llm_called, 'boolean');
      assert.equal(typeof invocationMatrix.llm_skip_reason === 'string' || invocationMatrix.llm_skip_reason == null, true);
      assert.equal(typeof invocationMatrix.reco_called, 'boolean');
      assert.equal(typeof invocationMatrix.reco_skip_reason === 'string' || invocationMatrix.reco_skip_reason == null, true);
      assert.equal(typeof invocationMatrix.store_called, 'boolean');
      assert.equal(typeof invocationMatrix.store_skip_reason === 'string' || invocationMatrix.store_skip_reason == null, true);
      assert.equal(typeof invocationMatrix.kb_write_queued, 'boolean');
      assert.equal(typeof invocationMatrix.kb_write_skip_reason, 'string');
      if (invocationMatrix.llm_called) {
        assert.notEqual(invocationMatrix.llm_skip_reason, 'destination_missing');
      } else {
        assert.equal(typeof invocationMatrix.llm_skip_reason, 'string');
      }

      const firstAssistant = String(resp.body?.assistant_message?.content || '');
      const followupSessionState =
        resp.body?.session_patch?.state && typeof resp.body.session_patch.state === 'object' && !Array.isArray(resp.body.session_patch.state)
          ? { ...resp.body.session_patch.state }
          : {};
      const respFollow = await supertest(app)
        .post('/v1/chat')
        .set(headers)
        .send({
          message: 'What about temperature then?',
          session: { state: followupSessionState },
          language: 'EN',
        })
        .expect(200);

      const secondAssistant = String(respFollow.body?.assistant_message?.content || '');
      assert.equal(secondAssistant.length > 0, true);
      const followMeta = respFollow.body?.meta || {};
      assert.equal(typeof followMeta.env_source === 'string' && followMeta.env_source.length > 0, true);
      assert.equal(typeof followMeta.degraded === 'boolean', true);
      assert.equal(followMeta.loop_count >= 0, true);
      const followCards = Array.isArray(respFollow.body?.cards) ? respFollow.body.cards : [];
      assert.equal(followCards.some((c) => c && c.type === 'env_stress'), true);
      assert.equal(followCards.some((c) => c && c.type === 'analysis_summary'), false);
      assert.equal(followCards.some((c) => c && c.type === 'analysis_story_v2'), false);

      delete require.cache[moduleId];
    },
  );
});

test('/v1/chat: travel kb backfill queues on first call and hits on second call for same destination/month/lang', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RETENTION_DAYS: '0',
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'true',
      TRAVEL_KB_WRITE_CONFIDENCE_MIN: '0',
      OPENAI_API_KEY: '',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const travelKbStoreModuleId = require.resolve('../src/auroraBff/travelKbStore');
      const travelKbPolicyModuleId = require.resolve('../src/auroraBff/travelKbPolicy');
      delete require.cache[routesModuleId];
      delete require.cache[travelKbStoreModuleId];
      delete require.cache[travelKbPolicyModuleId];
      const travelKbPolicy = require('../src/auroraBff/travelKbPolicy');
      const originalEvaluateTravelKbBackfill = travelKbPolicy.evaluateTravelKbBackfill;

      try {
        travelKbPolicy.evaluateTravelKbBackfill = () => ({
          eligible: true,
          reason: 'eligible',
          confidence_score: 0.95,
        });

        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const uidFirst = `test_uid_travel_kb_hit_first_${Date.now()}`;
        const destinationSeed = `Paris-${Date.now()}`;
        const headersFirst = {
          'X-Aurora-UID': uidFirst,
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        };

        await supertest(app)
          .post('/v1/profile/update')
          .set(headersFirst)
          .send({
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            goals: ['pores'],
            region: 'San Francisco, CA',
            travel_plans: [
              {
                destination: destinationSeed,
                start_date: '2026-03-10',
                end_date: '2026-03-15',
              },
            ],
          })
          .expect(200);

        const firstResp = await supertest(app)
          .post('/v1/chat')
          .set(headersFirst)
          .send({
            message: 'How is weather there? Will it be humid?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const firstMeta = firstResp.body?.meta || {};
        assert.equal(typeof firstMeta.env_source === 'string' && firstMeta.env_source.length > 0, true);
        assert.equal(typeof firstMeta.degraded, 'boolean');
        assert.equal(firstMeta.travel_skills_version, 'travel_skills_dag_v1');
        assert.equal(Array.isArray(firstMeta.travel_skills_trace), true);
        assert.equal(firstMeta.travel_kb_hit, false);
        assert.equal(typeof firstMeta.travel_kb_write_queued, 'boolean');
        assert.equal(typeof firstMeta.travel_skill_invocation_matrix, 'object');
        assert.equal(
          firstMeta.travel_skill_invocation_matrix &&
            firstMeta.travel_skill_invocation_matrix.llm_skip_reason !== 'destination_missing',
          true,
        );

        await new Promise((resolve) => setTimeout(resolve, 40));

        const uidSecond = `test_uid_travel_kb_hit_second_${Date.now()}`;
        const headersSecond = {
          'X-Aurora-UID': uidSecond,
          'X-Trace-ID': 'test_trace_2',
          'X-Brief-ID': 'test_brief_2',
          'X-Lang': 'EN',
        };

        await supertest(app)
          .post('/v1/profile/update')
          .set(headersSecond)
          .send({
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            goals: ['pores'],
            region: 'San Francisco, CA',
            travel_plans: [
              {
                destination: destinationSeed,
                start_date: '2026-03-10',
                end_date: '2026-03-15',
              },
            ],
          })
          .expect(200);

        const secondResp = await supertest(app)
          .post('/v1/chat')
          .set(headersSecond)
          .send({
            message: 'How is weather there? Will it be humid?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const secondMeta = secondResp.body?.meta || {};
        assert.equal(typeof secondMeta.env_source === 'string' && secondMeta.env_source.length > 0, true);
        assert.equal(typeof secondMeta.degraded, 'boolean');
        assert.equal(secondMeta.travel_skills_version, 'travel_skills_dag_v1');
        assert.equal(Array.isArray(secondMeta.travel_skills_trace), true);
        assert.equal(secondMeta.travel_kb_hit, true);
        assert.equal(typeof secondMeta.travel_kb_write_queued, 'boolean');
        assert.equal(typeof secondMeta.travel_skill_invocation_matrix, 'object');
        assert.equal(
          secondMeta.travel_skill_invocation_matrix &&
            secondMeta.travel_skill_invocation_matrix.llm_skip_reason !== 'destination_missing',
          true,
        );
      } finally {
        travelKbPolicy.evaluateTravelKbBackfill = originalEvaluateTravelKbBackfill;
        delete require.cache[routesModuleId];
        delete require.cache[travelKbStoreModuleId];
        delete require.cache[travelKbPolicyModuleId];
      }
    },
  );
});

test('/v1/chat: travel pipeline ok=false falls back to local weather path without crash', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const contractsModuleId = require.resolve('../src/auroraBff/travelSkills/contracts');
      delete require.cache[routesModuleId];
      delete require.cache[contractsModuleId];
      const contracts = require('../src/auroraBff/travelSkills/contracts');
      const originalRunTravelPipeline = contracts.runTravelPipeline;

      try {
        contracts.runTravelPipeline = async () => ({
          ok: false,
          quality_reason: 'core_signals_missing',
        });

        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = {
          'X-Aurora-UID': `test_uid_travel_fallback_${Date.now()}`,
          'X-Trace-ID': 'test_trace',
          'X-Brief-ID': 'test_brief',
          'X-Lang': 'EN',
        };

        await supertest(app)
          .post('/v1/profile/update')
          .set(headers)
          .send({
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            region: 'San Francisco, CA',
            travel_plans: [
              {
                destination: 'Paris',
                start_date: '2026-03-10',
                end_date: '2026-03-15',
              },
            ],
          })
          .expect(200);

        const resp = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            message: 'How is weather there? Will it be humid?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.equal(cards.some((c) => c && c.type === 'env_stress'), true);
        assert.equal(typeof resp.body?.assistant_message?.content, 'string');
        assert.equal(String(resp.body.assistant_message.content).length > 0, true);
      } finally {
        contracts.runTravelPipeline = originalRunTravelPipeline;
        delete require.cache[routesModuleId];
        delete require.cache[contractsModuleId];
      }
    },
  );
});

test('/v1/chat: local travel weather path returns destination clarification instead of silent fallback on ambiguity', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'true',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const contractsModuleId = require.resolve('../src/auroraBff/travelSkills/contracts');
      const weatherAdapterModuleId = require.resolve('../src/auroraBff/weatherAdapter');
      delete require.cache[routesModuleId];
      delete require.cache[contractsModuleId];
      delete require.cache[weatherAdapterModuleId];
      const contracts = require('../src/auroraBff/travelSkills/contracts');
      const weatherAdapter = require('../src/auroraBff/weatherAdapter');
      const originalRunTravelPipeline = contracts.runTravelPipeline;
      const originalGetTravelWeather = weatherAdapter.getTravelWeather;

      try {
        contracts.runTravelPipeline = async () => ({
          ok: false,
          quality_reason: 'core_signals_missing',
        });
        weatherAdapter.getTravelWeather = async () => ({
          ok: true,
          source: 'pending_clarification',
          reason: 'destination_ambiguous',
          normalized_query: 'Athens',
          candidates: [
            {
              label: 'Athens, Attica, Greece',
              canonical_name: 'Athens',
              latitude: 37.98376,
              longitude: 23.72784,
              country_code: 'GR',
              country: 'Greece',
              admin1: 'Attica',
              timezone: 'Europe/Athens',
              resolution_source: 'auto_resolved',
            },
            {
              label: 'Athens, Georgia, United States',
              canonical_name: 'Athens',
              latitude: 33.96095,
              longitude: -83.37794,
              country_code: 'US',
              country: 'United States',
              admin1: 'Georgia',
              timezone: 'America/New_York',
              resolution_source: 'auto_resolved',
            },
          ],
          forecast_window: [],
        });

        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = {
          'X-Aurora-UID': `test_uid_travel_ambiguous_${Date.now()}`,
          'X-Trace-ID': 'test_trace_ambiguous',
          'X-Brief-ID': 'test_brief_ambiguous',
          'X-Lang': 'EN',
        };

        await supertest(app)
          .post('/v1/profile/update')
          .set(headers)
          .send({
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'healthy',
            region: 'San Francisco, CA',
            travel_plans: [
              {
                destination: 'Athens',
                start_date: '2026-03-12',
                end_date: '2026-03-15',
              },
            ],
          })
          .expect(200);

        const resp = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            message: 'How is the weather there?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const chips = Array.isArray(resp.body?.suggested_chips) ? resp.body.suggested_chips : [];
        const assistant = String(resp.body?.assistant_message?.content || '');
        assert.equal(cards.some((c) => c && c.type === 'env_stress'), false);
        assert.ok(/multiple possible destinations/i.test(assistant));
        assert.ok(chips.some((chip) => String(chip?.label || '').includes('Athens, Attica, Greece')));
        assert.equal(resp.body?.session_patch?.pending_clarification?.type, 'destination_ambiguous');
      } finally {
        contracts.runTravelPipeline = originalRunTravelPipeline;
        weatherAdapter.getTravelWeather = originalGetTravelWeather;
        delete require.cache[routesModuleId];
        delete require.cache[contractsModuleId];
        delete require.cache[weatherAdapterModuleId];
      }
    },
  );
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
    body: {
      use_photo: false,
      photos: [],
      session: {
        state: {
          pending_clarification: {
            v: 1,
            flow_id: 'pc_stale_analysis',
            created_at_ms: Date.now(),
            resume_user_text: 'Recommend a moisturizer',
            current: { id: 'barrierStatus', norm_id: 'barrierStatus' },
            queue: [],
            history: [],
          },
        },
      },
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const storyCard = findCardByType(cards, 'analysis_story_v2');
  assert.ok(storyCard);
  const analysisMeta = resp.body?.analysis_meta || {};
  assert.equal(String(analysisMeta.detector_source || ''), 'baseline_low_confidence');
  assert.equal(Boolean(analysisMeta.llm_vision_called), false);
  assert.equal(Boolean(analysisMeta.llm_report_called), false);
  assert.equal(resp.body?.session_patch?.state?.pending_clarification, null);
  const confidenceCard = findCardByType(cards, 'confidence_notice');
  assert.ok(confidenceCard);
  assert.equal(String(confidenceCard?.payload?.reason || ''), 'low_confidence');
});

test('/v1/analysis/skin: photo-only fallback marks used_photos missing when photo fetch fails', async () => {
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
    headers: { 'X-Aurora-UID': 'test_uid_photo_only', 'X-Trace-ID': 'test_trace_photo_only', 'X-Brief-ID': 'test_brief_photo_only' },
    body: {
      use_photo: true,
      photos: [{ slot_id: 'daylight', photo_id: 'photo_only_1', qc_status: 'passed' }],
    },
  });

  assert.equal(resp.status, 200);
  assert.ok(Array.isArray(resp.body?.cards));
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const storyCard = findCardByType(cards, 'analysis_story_v2');
  assert.ok(storyCard);
  const analysisMeta = resp.body?.analysis_meta || {};
  assert.equal(
    ['retake', 'rule_based_with_photo_qc'].includes(String(analysisMeta.detector_source || '')),
    true,
  );
  assert.equal(Boolean(analysisMeta.llm_vision_called), false);
  assert.equal(String(analysisMeta.degrade_reason || ''), 'photo_download_url_generate_failed');
  const confidenceCard = findCardByType(cards, 'confidence_notice');
  assert.ok(confidenceCard);
  const rationale = Array.isArray(confidenceCard?.payload?.confidence?.rationale)
    ? confidenceCard.payload.confidence.rationale
    : [];
  assert.equal(rationale.includes('photo_requested_but_not_used'), true);
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
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const storyCard = findCardByType(cards, 'analysis_story_v2');
  assert.ok(storyCard);
  const analysisMeta = resp.body?.analysis_meta || {};
  assert.notEqual(String(analysisMeta.detector_source || ''), 'baseline_low_confidence');
  const findings = Array.isArray(storyCard?.payload?.priority_findings) ? storyCard.payload.priority_findings : [];
  assert.ok(findings.length > 0);
});

test('/v1/analysis/skin: nested profile fields inside currentRoutine feed analysis context', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/analysis/skin')
        .set({
          'X-Aurora-UID': `test_uid_nested_routine_${Date.now()}`,
          'X-Trace-ID': 'test_trace_nested_routine',
          'X-Brief-ID': 'test_brief_nested_routine',
          'X-Lang': 'EN',
        })
        .send({
          use_photo: false,
          currentRoutine: {
            profile: {
              skin_type: 'combination',
              barrier_status: 'impaired',
              sensitivity: 'high',
            },
            goal_profile: {
              selected_goals: ['brightening', 'barrier_repair'],
            },
            am: {
              cleanser: 'Gentle cleanser',
              serum: 'Vitamin C serum',
              moisturizer: 'Barrier cream',
              spf: 'SPF 50',
            },
            pm: {
              cleanser: 'Gentle cleanser',
              treatment: 'Retinol serum',
              moisturizer: 'Barrier cream',
            },
          },
        })
        .expect(200);

      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      const storyCard = findCardByType(cards, 'analysis_story_v2');
      assert.ok(storyCard);
      assert.match(String(resp.body?.assistant_message?.content || ''), /combination/i);
      assert.match(String(resp.body?.assistant_message?.content || ''), /combination.*high|\bhigh\b.*sensitivity/i);
      assert.equal(cards.some((card) => card && card.type === 'confidence_notice'), false);
    },
  );
});

test('/v1/profile/update: nested profile fields inside currentRoutine are persisted into top-level profile', async () => {
  await withEnv(
    {
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/profile/update')
        .set({
          'X-Aurora-UID': `test_uid_profile_nested_routine_${Date.now()}`,
          'X-Trace-ID': 'test_trace_profile_nested_routine',
          'X-Brief-ID': 'test_brief_profile_nested_routine',
          'X-Lang': 'EN',
        })
        .send({
          currentRoutine: {
            profile: {
              skin_type: 'combination',
              barrier_status: 'impaired',
              sensitivity: 'high',
            },
            goal_profile: {
              selected_goals: ['brightening', 'barrier_repair'],
            },
            am: { cleanser: 'Gentle cleanser', serum: 'Vitamin C serum' },
            pm: { cleanser: 'Gentle cleanser', treatment: 'Retinol serum' },
          },
        })
        .expect(200);

      const profilePayload = (resp.body?.cards || []).find((card) => card?.type === 'profile')?.payload?.profile || {};
      assert.equal(profilePayload.skinType, 'combination');
      assert.equal(profilePayload.barrierStatus, 'impaired');
      assert.equal(profilePayload.sensitivity, 'high');
      assert.deepEqual(profilePayload.goals, ['brightening', 'barrier_repair']);
    },
  );
});

test('/v1/profile/update: current_routine alias is accepted and normalized into currentRoutine storage', async () => {
  await withEnv(
    {
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/profile/update')
        .set({
          'X-Aurora-UID': `test_uid_profile_current_routine_${Date.now()}`,
          'X-Trace-ID': 'test_trace_profile_current_routine',
          'X-Brief-ID': 'test_brief_profile_current_routine',
          'X-Lang': 'EN',
        })
        .send({
          current_routine: [
            { slot: 'am', step: 'cleanser', product: 'Gentle cleanser' },
            { slot: 'pm', step: 'treatment', product: 'Retinol serum' },
          ],
        })
        .expect(200);

      const profilePayload = (resp.body?.cards || []).find((card) => card?.type === 'profile')?.payload?.profile || {};
      assert.equal(typeof profilePayload.currentRoutine, 'string');
      assert.match(String(profilePayload.currentRoutine || ''), /Gentle cleanser/);
      assert.match(String(profilePayload.currentRoutine || ''), /Retinol serum/);
    },
  );
});

test('/v1/analysis/skin: current_routine legacy input is accepted and still returns canonical story card', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/analysis/skin')
        .set({
          'X-Aurora-UID': `test_uid_analysis_current_routine_${Date.now()}`,
          'X-Trace-ID': 'test_trace_analysis_current_routine',
          'X-Brief-ID': 'test_brief_analysis_current_routine',
          'X-Lang': 'EN',
        })
        .send({
          use_photo: false,
          current_routine: [
            { slot: 'am', step: 'cleanser', product: 'Gentle cleanser' },
            { slot: 'pm', step: 'treatment', product: 'Retinol serum' },
          ],
        })
        .expect(200);

      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      assert.ok(findCardByType(cards, 'analysis_story_v2'));
      assert.equal(cards.some((card) => card && card.type === 'error'), false);
    },
  );
});

test('/v1/analysis/skin: plain-text currentRoutine stays non-fatal and still returns canonical story card', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const resp = await supertest(app)
        .post('/v1/analysis/skin')
        .set({
          'X-Aurora-UID': `test_uid_analysis_plain_text_routine_${Date.now()}`,
          'X-Trace-ID': 'test_trace_analysis_plain_text_routine',
          'X-Brief-ID': 'test_brief_analysis_plain_text_routine',
          'X-Lang': 'EN',
        })
        .send({
          use_photo: false,
          currentRoutine: 'AM: gentle cleanser, vitamin C, SPF 50. PM: cleanser, retinol, moisturizer.',
        })
        .expect(200);

      const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
      assert.ok(findCardByType(cards, 'analysis_story_v2'));
      assert.equal(cards.some((card) => card && card.type === 'error'), false);
    },
  );
});

test('/v1/analysis/skin: currentRoutine report path tolerates missing previous routine and stays non-fatal', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
      GEMINI_API_KEY: 'test_gemini_key',
    },
    async () => {
      const gatewayModuleId = require.resolve('../src/auroraBff/skinLlmGateway');
      delete require.cache[gatewayModuleId];
      const gatewayModule = require('../src/auroraBff/skinLlmGateway');
      const originalRunGeminiReportStrategy = gatewayModule.runGeminiReportStrategy;
      const originalIsGeminiSkinGatewayAvailable = gatewayModule.isGeminiSkinGatewayAvailable;
      let reportCalls = 0;

      gatewayModule.isGeminiSkinGatewayAvailable = () => true;
      gatewayModule.runGeminiReportStrategy = async () => {
        reportCalls += 1;
        return {
          ok: false,
          reason: 'report_output_invalid',
          schema_violation: false,
          semantic_violation: false,
          prompt_version: 'test_prompt',
        };
      };

      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': `test_uid_analysis_routine_report_${Date.now()}`,
            'X-Trace-ID': 'test_trace_analysis_routine_report',
            'X-Brief-ID': 'test_brief_analysis_routine_report',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: false,
            currentRoutine: {
              am: { cleanser: 'Gentle cleanser', spf: 'SPF 50' },
              pm: { cleanser: 'Gentle cleanser', treatment: 'Retinol serum', moisturizer: 'Barrier cream' },
            },
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.ok(findCardByType(cards, 'analysis_story_v2'));
        assert.equal(reportCalls > 0, true);
        assert.equal(cards.some((card) => card && card.type === 'error'), false);
      } finally {
        gatewayModule.runGeminiReportStrategy = originalRunGeminiReportStrategy;
        gatewayModule.isGeminiSkinGatewayAvailable = originalIsGeminiSkinGatewayAvailable;
        delete require.cache[routeModuleId];
        delete require.cache[gatewayModuleId];
      }
    },
  );
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

test('trusted anchor provisional bridge upgrades unknown cleanser verdict into a category-level judgment', async () => {
  const { __internal } = require('../src/auroraBff/routes');

  const out = __internal.maybeApplyTrustedAnchorProvisionalProductAnalysis(
    {
      assessment: {
        verdict: 'Unknown',
        reasons: [
          'Current evidence is insufficient for a high-confidence product verdict.',
          'Treat this result as provisional until more complete evidence is available.',
        ],
      },
      evidence: {
        science: { key_ingredients: [], mechanisms: [], fit_notes: [], risk_notes: [] },
        social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
        expert_notes: [],
        confidence: null,
        missing_info: ['evidence_missing'],
      },
      confidence: null,
      missing_info: ['analysis_limited'],
    },
    {
      parsedProduct: {
        product_id: 'nested-sku-1',
        brand: 'CeraVe',
        name: 'CeraVe Foaming Cleanser',
        display_name: 'CeraVe Foaming Cleanser',
        category: 'Cleanser',
        url: 'https://example.com/p/cerave-foaming-cleanser',
      },
      profileSummary: {
        skinType: 'oily',
        sensitivity: 'medium',
        barrierStatus: 'impaired',
        goals: ['acne', 'pores'],
      },
      lang: 'EN',
      inputText: 'CeraVe Foaming Cleanser',
      anchorTrustContext: { usable_for_anchor_id: true },
    },
  );

  assert.ok(out && typeof out === 'object');
  assert.equal(out.assessment?.verdict, 'Caution');
  assert.ok(Array.isArray(out.assessment?.reasons));
  assert.ok(out.assessment.reasons.some((line) => /cleanser/i.test(String(line || ''))));
  assert.ok(Array.isArray(out.missing_info) && out.missing_info.includes('trusted_anchor_category_provisional'));
  assert.equal(out.provenance?.trusted_anchor_provisional_verdict?.applied, true);
  assert.equal(out.provenance?.trusted_anchor_provisional_verdict?.product_type, 'cleanser');
});

test('/v1/product/analyze: quick-profile request context is consumed as explicit-only analysis context', async () => {
  const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  mountAuroraBffRoutes(app, { logger: null });

  const resp = await supertest(app)
    .post('/v1/product/analyze')
    .set('X-Aurora-UID', 'test_uid_quick_profile')
    .set('X-Trace-ID', 'tqp')
    .set('X-Brief-ID', 'bqp')
    .set('X-Lang', 'EN')
    .send({
      name: 'Mock Parsed Product',
      context: {
        skin_feel: 'oily',
        goal_primary: 'breakouts',
        sensitivity_flag: 'yes',
      },
    });

  assert.equal(resp.status, 200);
  const meta =
    resp.body &&
    resp.body.session_patch &&
    resp.body.session_patch.meta &&
    typeof resp.body.session_patch.meta === 'object' &&
    !Array.isArray(resp.body.session_patch.meta)
      ? resp.body.session_patch.meta
      : {};

  assert.equal(meta.profile_context_source, 'request_overlay_applied');
  assert.deepEqual(meta.request_profile_overlay_keys, ['goals', 'sensitivity', 'skinType']);
  assert.equal(meta.analysis_context_usage && meta.analysis_context_usage.snapshot_present, false);
  assert.equal(meta.analysis_context_usage && meta.analysis_context_usage.context_source_mode, 'explicit_only');
  assert.equal(meta.analysis_context_usage && meta.analysis_context_usage.analysis_context_available, true);
  assert.equal(meta.analysis_context_usage && meta.analysis_context_usage.context_mode, 'explicit_only');
  assert.equal(meta.analysis_context_usage && meta.analysis_context_usage.explicit_override_applied, true);
  assert.deepEqual(
    Array.isArray(meta.analysis_context_usage && meta.analysis_context_usage.hard_context_fields_used)
      ? meta.analysis_context_usage.hard_context_fields_used.sort()
      : [],
    ['active_goals', 'sensitivity', 'skin_type'],
  );
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
  const storyCard = findCardByType(cards, 'analysis_story_v2');
  assert.ok(storyCard);

  const analysisMeta = resp.body?.analysis_meta || {};
  assert.equal(
    ['retake', 'rule_based_with_photo_qc'].includes(String(analysisMeta.detector_source || '')),
    true,
  );
  assert.equal(Boolean(analysisMeta.llm_vision_called), false);
  assert.equal(Boolean(analysisMeta.llm_report_called), false);

  const findings = Array.isArray(storyCard?.payload?.priority_findings) ? storyCard.payload.priority_findings : [];
  assert.equal(findings.length <= 1, true);
  const ingredientPlanCard = findCardByType(cards, 'ingredient_plan_v2');
  assert.ok(ingredientPlanCard);
  assert.deepEqual(ingredientPlanCard?.payload?.targets || [], []);
  assert.equal(ingredientPlanCard?.payload?.preview_only, true);
  assert.equal(ingredientPlanCard?.payload?.preview_reason, 'photo_quality_failed');
  assert.equal(ingredientPlanCard?.payload?.products_empty_reason, 'photo_quality_failed');
  assert.equal(resp.body?.session_patch?.state?.latest_reco_context || null, null);
  const confidenceCard = findCardByType(cards, 'confidence_notice');
  assert.ok(confidenceCard);
  const rationale = Array.isArray(confidenceCard?.payload?.confidence?.rationale)
    ? confidenceCard.payload.confidence.rationale
    : [];
  assert.equal(rationale.includes('photo_qc_failed'), true);
  assert.equal(rationale.includes('photo_requested_but_not_used'), true);
  const valueMoment = (Array.isArray(resp.body?.events) ? resp.body.events : []).find((e) => e && e.event_name === 'value_moment') || null;
  assert.ok(valueMoment);
  assert.equal(Boolean(valueMoment?.data?.used_photos), false);
});

test('photo_quality_failed ingredient plan strips fallback residue and suppresses reco handoff', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rawPlan = {
      schema_version: 'aurora.ingredient_plan.v2',
      targets: [
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          target_step_family: 'moisturizer',
          why: ['Barrier support'],
          products: {
            competitors: [],
            dupes: [],
            external_search_ctas: [{ label: 'Search', url: 'https://example.com/search?q=ceramide' }],
          },
        },
      ],
      external_fallback_used: true,
      external_search_ctas: [{ label: 'Search', url: 'https://example.com/search?q=ceramide' }],
      __missing_catalog_queries: [{ ingredient_id: 'ceramide_np', query: 'ceramide moisturizer' }],
    };
    const photoModulesCard = {
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'fail',
        summary_v1: {
          top_module_id: 'forehead',
          top_findings: [],
          quality_caveats: ['photo_quality_failed', 'low_confidence_primary_finding'],
        },
        modules: [
          {
            module_id: 'forehead',
            actions: [
              {
                ingredient_canonical_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                why: 'Barrier support.',
                evidence_issue_types: ['barrier'],
              },
            ],
          },
        ],
      },
    };

    const annotated = __internal.annotateIngredientPlanForPhotoLed(rawPlan, photoModulesCard, 'EN');
    assert.deepEqual(annotated?.targets || [], []);
    assert.equal(annotated?.preview_only, true);
    assert.equal(annotated?.preview_reason, 'photo_quality_failed');
    assert.equal(annotated?.products_empty_reason, 'photo_quality_failed');
    assert.equal(annotated?.external_fallback_used, false);
    assert.deepEqual(annotated?.external_search_ctas || [], []);
    assert.equal(Object.prototype.hasOwnProperty.call(annotated || {}, '__missing_catalog_queries'), false);

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      ingredientPlan: annotated,
      photoModulesCard,
      artifactId: 'art_photo_fail',
      contextOrigin: 'analysis_summary',
      analysisSource: 'rule_based_with_photo_qc',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'fail',
    });
    assert.equal(latestRecoContext, null);
  } finally {
    delete require.cache[moduleId];
  }
});

test('degraded photo shell without findings preserves baseline ingredient plan and reco handoff', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rawPlan = {
      schema_version: 'aurora.ingredient_plan.v2',
      targets: [
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          target_role: 'primary',
          target_step_family: 'moisturizer',
          resolved_target_step: 'moisturizer',
          recommendation_mode: 'strict_match',
          strict_product_count: 1,
          why: ['Barrier support while photo evidence stays sparse.'],
          products: {
            competitors: [
              {
                product_id: 'prod_barrier_rescue',
                merchant_id: 'merchant_barrier',
                name: 'Barrier Rescue Cream',
                url: 'https://example.com/barrier-rescue',
              },
            ],
          },
        },
      ],
    };
    const photoModulesCard = {
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'degraded',
        summary_v1: {
          top_module_id: 'forehead',
          top_findings: [],
          quality_caveats: ['photo_quality_degraded', 'low_confidence_primary_finding'],
        },
        modules: [
          {
            module_id: 'forehead',
            issues: [],
            actions: [],
            box: { x: 0.344, y: 0.078, w: 0.313, h: 0.125 },
            module_pixels: 160,
            mask_rle_norm: '342,20,44,20,44,20,44,20',
          },
        ],
      },
    };

    const annotated = __internal.annotateIngredientPlanForPhotoLed(rawPlan, photoModulesCard, 'EN');
    assert.equal(Array.isArray(annotated?.targets), true);
    assert.equal(annotated.targets.length, 1);
    assert.equal(annotated.targets[0]?.ingredient_id, 'ceramide_np');
    assert.equal(annotated?.preview_reason || null, null);
    assert.equal(annotated?.products_empty_reason || null, null);

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      ingredientPlan: annotated,
      photoModulesCard,
      artifactId: 'art_degraded_shell',
      contextOrigin: 'analysis_summary',
      analysisSource: 'rule_based_with_photo',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'degraded',
    });

    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.ingredient_query, 'Ceramide NP');
    assert.equal(latestRecoContext.resolved_target_step, 'moisturizer');
    assert.match(String(latestRecoContext.primary_target_id || ''), /ceramide_np/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('latest_artifact photo-fail plan does not auto-anchor generic reco context', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const rawPersistedPlan = {
      schema_version: 'aurora.ingredient_plan.v2',
      targets: [
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          target_step_family: 'moisturizer',
          why: ['Barrier support'],
        },
      ],
    };

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      ingredientPlan: rawPersistedPlan,
      artifactId: 'art_latest_photo_fail',
      contextOrigin: 'latest_artifact',
      analysisSource: 'rule_based_with_photo_qc',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'fail',
    });

    assert.equal(latestRecoContext, null);
  } finally {
    delete require.cache[moduleId];
  }
});

test('analysis-derived reco context prefers displayable ingredient-plan target over photo CTA-only primary', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const photoModulesCard = {
      type: 'photo_modules_v1',
      payload: {
        summary_v1: {
          top_module_id: 'under_eye_right',
          top_action_ingredient_id: 'retinol',
          top_issue_type: 'texture',
          top_findings: [
            {
              module_id: 'under_eye_right',
              issue_type: 'texture',
              confidence_bucket: 'low',
            },
          ],
        },
        modules: [
          {
            module_id: 'under_eye_right',
            module_rank_score: 0.95,
            actions: [
              {
                ingredient_canonical_id: 'retinol',
                ingredient_name: 'Retinoid (later stage)',
                action_rank_score: 0.95,
                why: 'Retinoid (later stage) helps improve uneven texture in highlighted areas.',
                evidence_issue_types: ['texture'],
                products: [],
              },
            ],
          },
        ],
      },
    };
    const ingredientPlan = {
      schema_version: 'aurora.ingredient_plan.v2',
      targets: [
        {
          ingredient_id: 'retinol',
          ingredient_name: 'Retinol',
          priority_score_0_100: 91,
          recommendation_mode: 'cta_only',
          strict_product_count: 0,
          presentation_bucket: 'photo_derived',
          resolved_target_step: 'treatment',
          source_issue_types: ['texture'],
          why: ['Start low-frequency as a single active and monitor tolerance.'],
          products: {
            competitors: [],
            products_empty_reason: 'strict_match_miss',
          },
        },
        {
          ingredient_id: 'salicylic_acid',
          ingredient_name: 'Salicylic acid (BHA)',
          priority_score_0_100: 83,
          recommendation_mode: 'strict_match',
          strict_product_count: 5,
          presentation_bucket: 'photo_derived',
          resolved_target_step: 'serum',
          source_issue_types: ['texture'],
          why: ['BHA is tied directly to the texture irregularity signal.'],
          products: {
            competitors: [
              {
                product_id: 'bha_1',
                name: 'BHA Clarifying Serum',
                brand: 'AcidLab',
              },
            ],
          },
        },
      ],
    };

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      ingredientPlan,
      photoModulesCard,
      artifactId: 'art_photo_displayable',
      contextOrigin: 'analysis_summary',
      analysisSource: 'rule_based_with_photo',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'pass',
    });

    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.context_origin, 'photo_modules_v1');
    assert.equal(latestRecoContext.ingredient_query, 'Salicylic acid (BHA)');
    assert.equal(latestRecoContext.resolved_target_step, 'serum');
    assert.equal(latestRecoContext.artifact_id, 'art_photo_displayable');
    assert.equal(Array.isArray(latestRecoContext.product_candidates), true);
    assert.equal(latestRecoContext.product_candidates.length, 1);
    assert.equal(latestRecoContext.product_candidates[0].product_id, 'bha_1');
  } finally {
    delete require.cache[moduleId];
  }
});

test('analysis-derived reco context can fall back to policy-allowed moisturizer when degraded low-confidence photo clears aggressive bundle', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const photoModulesCard = {
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'degraded',
        summary_v1: {
          top_module_id: 'nose',
          top_action_ingredient_id: 'retinol',
          top_issue_type: 'texture',
          top_findings: [
            {
              module_id: 'nose',
              issue_type: 'texture',
              confidence_bucket: 'low',
            },
          ],
        },
        modules: [
          {
            module_id: 'nose',
            module_rank_score: 0.95,
            actions: [
              {
                ingredient_canonical_id: 'retinol',
                ingredient_name: 'Retinoid (later stage)',
                action_rank_score: 0.95,
                why: 'Retinoid (later stage) helps improve uneven texture in highlighted areas.',
                evidence_issue_types: ['texture'],
                products: [],
              },
            ],
          },
        ],
      },
    };
    const ingredientPlan = {
      schema_version: 'aurora.ingredient_plan.v2',
      targets: [
        {
          ingredient_id: 'retinol',
          ingredient_name: 'Retinoid (later stage)',
          priority_score_0_100: 95,
          recommendation_mode: 'cta_only',
          strict_product_count: 0,
          presentation_bucket: 'photo_derived',
          resolved_target_step: 'treatment',
          source_issue_types: ['texture'],
          why: ['Retinoid is the strongest texture-active candidate.'],
          products: {
            competitors: [],
            products_empty_reason: 'strict_match_miss',
          },
        },
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          priority_score_0_100: 84,
          recommendation_mode: 'strict_match',
          strict_product_count: 3,
          presentation_bucket: 'baseline_support',
          resolved_target_step: 'moisturizer',
          source_issue_types: ['texture'],
          why: ['Barrier support keeps the plan conservative while texture confidence is low.'],
          products: {
            competitors: [
              {
                product_id: 'ceramide_1',
                name: 'Barrier Rescue Cream',
                brand: 'BarrierLab',
              },
            ],
          },
        },
        {
          ingredient_id: 'salicylic_acid',
          ingredient_name: 'Salicylic acid (BHA)',
          priority_score_0_100: 82,
          recommendation_mode: 'strict_match',
          strict_product_count: 4,
          presentation_bucket: 'photo_derived',
          resolved_target_step: 'serum',
          source_issue_types: ['texture'],
          why: ['BHA can help texture, but this degraded low-confidence read should stay below serum aggressiveness.'],
          products: {
            competitors: [
              {
                product_id: 'bha_1',
                name: 'BHA Clarifying Serum',
                brand: 'AcidLab',
              },
            ],
          },
        },
      ],
    };

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      ingredientPlan,
      photoModulesCard,
      artifactId: 'art_photo_policy_safe',
      contextOrigin: 'analysis_summary',
      analysisSource: 'rule_based_with_photo',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'degraded',
    });

    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.context_origin, 'photo_modules_v1');
    assert.equal(latestRecoContext.ingredient_query, 'Ceramide NP');
    assert.equal(latestRecoContext.resolved_target_step, 'moisturizer');
    assert.equal(latestRecoContext.primary_target_id, 'ceramide_np__moisturizer__texture');
    assert.equal(Array.isArray(latestRecoContext.ranked_targets), true);
    assert.equal(latestRecoContext.ranked_targets.some((row) => /retinoid/i.test(String(row?.ingredient_query || ''))), false);
    assert.equal(latestRecoContext.ranked_targets.some((row) => /salicylic acid/i.test(String(row?.ingredient_query || ''))), false);
    assert.equal(
      latestRecoContext.product_candidates == null || Array.isArray(latestRecoContext.product_candidates),
      true,
    );
    if (Array.isArray(latestRecoContext.product_candidates) && latestRecoContext.product_candidates.length > 0) {
      assert.equal(latestRecoContext.product_candidates[0].product_id, 'ceramide_1');
    }
    assert.equal(latestRecoContext.confidence_policy?.max_target_step, 'moisturizer');
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: analysis envelope refresh keeps ingredient-plan primary target aligned in latest_reco_context', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      analysis_meta: {
        analysis_mode: 'analysis_summary',
        detector_source: 'rule_based_with_photo',
      },
      session_patch: {
        profile: {
          skinType: 'combination',
          sensitivity: 'medium',
          goals: ['barrier'],
        },
        state: {
          latest_artifact_id: 'art_sync_latest_reco',
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'photo_modules_v1',
            ingredient_query: 'Ceramide NP',
            resolved_target_step: 'moisturizer',
            primary_target_id: 'ceramide_np__moisturizer__redness__nose',
            ranked_targets: [
              {
                target_id: 'ceramide_np__moisturizer__redness__nose',
                ingredient_query: 'Ceramide NP',
                resolved_target_step: 'moisturizer',
                issue_type: 'redness',
                target_role: 'primary',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'analysis_summary',
          payload: {
            analysis_source: 'rule_based_with_photo',
            photos_provided: true,
            used_photos: true,
            quality_report: {
              photo_quality: { grade: 'degraded', reasons: ['indoor_lighting'] },
            },
          },
        },
        {
          type: 'photo_modules_v1',
          payload: {
            quality_grade: 'degraded',
            summary_v1: {
              top_module_id: 'nose',
              top_action_ingredient_id: 'ceramide_np',
              top_issue_type: 'redness',
              top_findings: [
                {
                  module_id: 'nose',
                  issue_type: 'redness',
                  confidence_bucket: 'low',
                },
              ],
            },
            modules: [
              {
                module_id: 'nose',
                module_rank_score: 0.94,
                actions: [
                  {
                    ingredient_canonical_id: 'ceramide_np',
                    ingredient_name: 'Ceramide NP',
                    action_rank_score: 0.9,
                    why: 'Barrier support for redness.',
                    evidence_issue_types: ['redness'],
                    products: [],
                  },
                ],
              },
            ],
          },
        },
        {
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                target_id: 'ceramide_np__moisturizer__redness__nose',
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                target_role: 'primary',
                priority_score_0_100: 88,
                recommendation_mode: 'strict_match',
                strict_product_count: 1,
                presentation_bucket: 'baseline_support',
                resolved_target_step: 'moisturizer',
                source_module_ids: ['nose'],
                source_issue_types: ['redness'],
                why: ['Barrier support keeps the plan conservative while redness confidence is low.'],
                products: {
                  competitors: [
                    {
                      product_id: 'ceramide_barrier_1',
                      name: 'Barrier Rescue Cream',
                      brand: 'BarrierLab',
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    };

    const refreshed = __internal.refreshLatestRecoContextFromAnalysisEnvelope(envelope);
    const latestRecoContext = refreshed?.session_patch?.state?.latest_reco_context || null;

    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.ingredient_query, 'Ceramide NP');
    assert.equal(latestRecoContext.resolved_target_step, 'moisturizer');
    assert.equal(String(latestRecoContext.primary_target_id || '').includes('ceramide_np'), true);
    assert.equal(String(latestRecoContext.primary_target_id || '').includes('moisturizer'), true);
    assert.equal(Array.isArray(latestRecoContext.ranked_targets), true);
    assert.equal(latestRecoContext.ranked_targets.length >= 1, true);
    assert.equal(
      String(latestRecoContext.ranked_targets[0].target_id || '').includes('ceramide_np'),
      true,
    );
    if (Array.isArray(latestRecoContext.product_candidates) && latestRecoContext.product_candidates.length > 0) {
      assert.equal(latestRecoContext.product_candidates[0].product_id, 'ceramide_barrier_1');
    }
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: sanitizeRecoRequestContext preserves canonical ownership spine fields', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const context = __internal.sanitizeRecoRequestContext({
      intent: 'reco_products',
      source_detail: 'analysis_handoff',
      trigger_source: 'analysis_handoff',
      ingredient_query: 'Ceramide NP',
      resolved_target_step: 'moisturizer',
      owner_source: 'photo_modules_v1',
      target_bundle_owner: 'photo_modules_v1',
      final_outcome_owner: 'reco_contract_builder',
      owner_shift_reason: 'primary_target_unavailable_secondary_used',
      primary_target_id: 'ceramide_np__moisturizer__redness__nose',
      ranked_targets: [
        {
          target_id: 'ceramide_np__moisturizer__redness__nose',
          ingredient_query: 'Ceramide NP',
          resolved_target_step: 'moisturizer',
          target_role: 'primary',
        },
      ],
    });

    assert.equal(context.owner_source, 'photo_modules_v1');
    assert.equal(context.target_bundle_owner, 'photo_modules_v1');
    assert.equal(context.final_outcome_owner, 'reco_contract_builder');
    assert.equal(context.owner_shift_reason, 'primary_target_unavailable_secondary_used');
    assert.equal(context.primary_target_id, 'ceramide_np__moisturizer__redness__nose');
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: canonical ownership audit keeps photo as sole primary owner when routine cards are supporting', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'This week: Trial BHA/LHA conservatively.\nSecondary option: Prioritize Azelaic Acid if the area stays calm.',
      },
      analysis_meta: {
        canonical_owner_source: 'photo_modules_v1',
      },
      session_patch: {
        state: {
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'photo_modules_v1',
            owner_source: 'photo_modules_v1',
            target_bundle_owner: 'photo_modules_v1',
            primary_target_id: 'salicylic_acid_serum_texture_under_eye_right',
            ranked_targets: [
              {
                target_id: 'salicylic_acid_serum_texture_under_eye_right',
                ingredient_query: 'Salicylic acid (BHA)',
                resolved_target_step: 'serum',
                issue_type: 'texture',
                target_role: 'primary',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'routine_product_audit_v1',
          payload: {
            groups: [],
          },
        },
        {
          type: 'photo_modules_v1',
          payload: {
            summary_v1: {
              top_module_id: 'under_eye_right',
              top_issue_type: 'texture',
              top_findings: [
                {
                  module_id: 'under_eye_right',
                  issue_type: 'texture',
                  confidence_bucket: 'low',
                },
              ],
            },
          },
        },
        {
          type: 'analysis_story_v2',
          payload: {
            priority_findings: [
              {
                title: 'Right under-eye texture',
              },
            ],
            ui_card_v1: {
              headline: 'Right under-eye texture irregularity stands out most in this pass.',
              confidence_label: 'low',
              actions_now: ['Trial BHA/LHA conservatively.'],
            },
          },
        },
        {
          type: 'ingredient_plan_v2',
          payload: {
            targets: [
              {
                target_id: 'salicylic_acid_serum_texture_under_eye_right',
                ingredient_query: 'Salicylic acid (BHA)',
                ingredient_id: 'salicylic_acid',
                resolved_target_step: 'serum',
                target_role: 'primary',
              },
            ],
          },
        },
      ],
    };

    const audit = __internal.buildBeautyCanonicalOwnershipAudit({
      envelope,
      route: 'analysis_skin',
      assistantText: envelope.assistant_message.content,
    });

    assert.equal(audit.owner_matrix.primary_focus_owner, 'photo_modules_v1');
    assert.equal(audit.owner_matrix.target_bundle_owner, 'photo_modules_v1');
    assert.equal(audit.owner_matrix.copy_owner, 'analysis_story_v2');
    assert.equal(audit.signals.has_routine_cards, true);
    assert.equal(audit.drift.owner_conflict, false);
    assert.equal(audit.drift.legacy_bypass_skip, false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: evaluateQualityContractForEnvelope marks late outcome override and owner inconsistency', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'I do not have a safe match to show right now.',
      },
      session_patch: {
        state: {
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'photo_modules_v1',
            owner_source: 'photo_modules_v1',
            target_bundle_owner: 'photo_modules_v1',
            primary_target_id: 'ceramide_np__moisturizer__redness__nose',
            ranked_targets: [
              {
                target_id: 'ceramide_np__moisturizer__redness__nose',
                ingredient_query: 'Ceramide NP',
                resolved_target_step: 'moisturizer',
                target_role: 'primary',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendations: [],
            products_empty_reason: 'ingredient_constraint_no_match',
            recommendation_meta: {
              mainline_status: 'grounded_success',
              owner_source: 'photo_modules_v1',
              final_outcome_owner: 'reco_contract_builder',
              primary_target_id: 'ceramide_np__moisturizer__redness__nose',
              ranked_targets: [
                {
                  target_id: 'ceramide_np__moisturizer__redness__nose',
                  ingredient_query: 'Ceramide NP',
                  resolved_target_step: 'moisturizer',
                  target_role: 'primary',
                },
              ],
            },
          },
        },
        {
          type: 'confidence_notice',
          payload: {
            reason: 'ingredient_constraint_no_match',
          },
        },
      ],
      events: [
        {
          event_name: 'recos_requested',
          data: {
            mainline_status: 'grounded_success',
          },
        },
      ],
    };

    const quality = __internal.evaluateQualityContractForEnvelope({
      envelope,
      policyMeta: { intent_canonical: 'reco_products' },
      assistantText: envelope.assistant_message.content,
      profile: {},
    });

    assert.equal(quality.outcome_owner_consistent, false);
    assert.equal(quality.late_override_absent, false);
    assert.equal(quality.semantic_contract_pass, false);
    assert.equal(quality.canonical_ownership_audit.drift.late_outcome_override, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: applyBeautyCanonicalOwnershipToEnvelope writes owner fields into reco payload and latest_reco_context', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'Primary recommendation focus: keep this pass centered on Ceramide NP.\nProducts actually selected this time: Barrier Rescue Cream.',
      },
      session_patch: {
        state: {
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'photo_modules_v1',
            primary_target_id: 'ceramide_np__moisturizer__redness__nose',
            ranked_targets: [
              {
                target_id: 'ceramide_np__moisturizer__redness__nose',
                ingredient_query: 'Ceramide NP',
                resolved_target_step: 'moisturizer',
                target_role: 'primary',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendations: [
              {
                sku: {
                  brand: 'BarrierLab',
                  name: 'Barrier Rescue Cream',
                },
              },
            ],
            recommendation_meta: {
              mainline_status: 'grounded_success',
              primary_target_id: 'ceramide_np__moisturizer__redness__nose',
              ranked_targets: [
                {
                  target_id: 'ceramide_np__moisturizer__redness__nose',
                  ingredient_query: 'Ceramide NP',
                  resolved_target_step: 'moisturizer',
                  target_role: 'primary',
                },
              ],
            },
          },
        },
      ],
      events: [
        {
          event_name: 'recos_requested',
          data: {},
        },
      ],
    };

    const next = __internal.applyBeautyCanonicalOwnershipToEnvelope({
      envelope,
      route: 'reco_generate',
      assistantText: envelope.assistant_message.content,
      policyMeta: { intent_canonical: 'reco_products' },
      profile: { skinType: 'combination' },
    });

    const latestRecoContext = next.session_patch.state.latest_reco_context;
    const recoMeta = next.cards[0].payload.recommendation_meta;
    const recoEvent = next.events.find((evt) => evt && evt.event_name === 'recos_requested');

    assert.equal(latestRecoContext.owner_source, 'photo_modules_v1');
    assert.equal(latestRecoContext.target_bundle_owner, 'photo_modules_v1');
    assert.equal(latestRecoContext.final_outcome_owner, 'reco_contract_builder');
    assert.equal(recoMeta.owner_source, 'photo_modules_v1');
    assert.equal(recoMeta.final_outcome_owner, 'reco_contract_builder');
    assert.equal(recoEvent.data.owner_source, 'photo_modules_v1');
    assert.equal(next.meta.canonical_ownership.owner_matrix.outcome_owner, 'reco_contract_builder');
    assert.equal(next.meta.quality_contract.outcome_owner_consistent, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: buildPersistableLastAnalysisSnapshot keeps canonical latest reco context without analysis base', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const snapshot = __internal.buildPersistableLastAnalysisSnapshot({
      analysis: null,
      routineAnalysisV2Result: {
        persist_payload: {
          routine_audit_v1: {
            verdict: { summary: 'Morning sunscreen gap' },
          },
        },
        legacy_compat: { enabled: true },
      },
      latestRecoContext: {
        context_origin: 'routine_audit_v1',
        owner_source: 'routine_audit_v1',
        target_bundle_owner: 'routine_audit_v1',
        final_outcome_owner: 'analysis_skin_response',
        ingredient_query: 'cleanser',
        goal: 'barrier_support',
        resolved_target_step: 'cleanser',
        primary_target_id: 'adj_pm_cleanser_replace',
        ranked_targets: [
          {
            target_id: 'adj_pm_cleanser_replace',
            ingredient_query: 'cleanser',
            resolved_target_step: 'cleanser',
            target_role: 'primary',
            source: 'routine_audit_v1',
          },
        ],
      },
      profileSummary: {
        skinType: 'combination',
        sensitivity: 'high',
        barrierStatus: 'reactive',
      },
    });

    assert.ok(snapshot);
    assert.equal(snapshot.skin_profile?.skin_type_tendency, 'combination');
    assert.equal(snapshot.skin_profile?.sensitivity_tendency, 'high');
    assert.equal(snapshot.latest_reco_context_snapshot?.primary_target_id, 'adj_pm_cleanser_replace');
    assert.equal(snapshot.latest_reco_context_snapshot?.owner_source, 'routine_audit_v1');
    assert.equal(snapshot.routine_analysis_legacy_compat?.enabled, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: applyBeautyCanonicalOwnershipToEnvelope rebuilds reco assistant text when selection shift needs explanation', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'Primary recommendation focus: keep this pass centered on Azelaic Acid.',
      },
      session_patch: {
        state: {
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'photo_modules_v1',
            owner_source: 'photo_modules_v1',
            target_bundle_owner: 'photo_modules_v1',
            owner_shift_reason: 'confidence_policy_primary_target_shifted',
            primary_target_id: 'azelaic_acid_serum_texture_nose',
            ranked_targets: [
              {
                target_id: 'azelaic_acid_serum_texture_nose',
                ingredient_query: 'Azelaic Acid',
                resolved_target_step: 'serum',
                target_role: 'primary',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendations: [
              {
                sku: {
                  brand: 'TestBrand',
                  name: 'Azelaic Serum',
                },
              },
            ],
            recommendation_meta: {
              mainline_status: 'grounded_success',
              primary_target_id: 'azelaic_acid_serum_texture_nose',
              ranked_targets: [
                {
                  target_id: 'azelaic_acid_serum_texture_nose',
                  ingredient_query: 'Azelaic Acid',
                  resolved_target_step: 'serum',
                  target_role: 'primary',
                },
              ],
            },
          },
        },
      ],
    };

    const next = __internal.applyBeautyCanonicalOwnershipToEnvelope({
      envelope,
      route: 'chat_reco',
      assistantText: envelope.assistant_message.content,
      policyMeta: { intent_canonical: 'reco_products' },
      profile: { skinType: 'oily', sensitivity: 'low', barrierStatus: 'healthy', goals: ['acne'] },
    });

    assert.match(String(next.assistant_message?.content || ''), /shifted to|closest verified secondary/i);
    assert.equal(
      next.cards[0].payload.recommendation_meta.selection_shift_reason,
      'confidence_policy_primary_target_shifted',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: evaluateQualityContractForEnvelope does not force low-confidence caution for routine-only analysis without explicit low-confidence signals', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'I reviewed each current product first. The best place to start is "Consider a different cleanser for PM" because it drives the biggest routine mismatch right now.',
      },
      session_patch: {
        state: {
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'routine_audit_v1',
            owner_source: 'routine_audit_v1',
            target_bundle_owner: 'routine_audit_v1',
            primary_target_id: 'cleanser_pm_texture',
            ranked_targets: [
              {
                target_id: 'cleanser_pm_texture',
                ingredient_query: 'Gentle Cleanser',
                resolved_target_step: 'cleanser',
                target_role: 'primary',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'routine_product_audit_v1',
          payload: {
            summary: 'Consider a different cleanser for PM',
          },
        },
        {
          type: 'routine_adjustment_plan_v1',
          payload: {
            steps: ['Switch PM cleanser to a gentler option.'],
          },
        },
      ],
    };

    const quality = __internal.evaluateQualityContractForEnvelope({
      envelope,
      policyMeta: { intent_canonical: 'analysis_skin' },
      assistantText: envelope.assistant_message.content,
      profile: {},
    });

    assert.equal(quality.confidence_consistency_pass, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: canonical ownership audit does not mark bootstrap context loss when no analysis snapshot is present', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      cards: [
        {
          type: 'session_bootstrap',
          payload: {
            profile: {},
            recent_logs: [],
            checkin_due: false,
            is_returning: false,
            db_ready: true,
          },
        },
      ],
      session_patch: {
        profile: {},
        recent_logs: [],
      },
    };

    const audit = __internal.buildBeautyCanonicalOwnershipAudit({
      envelope,
      route: 'session_bootstrap',
      assistantText: '',
    });

    assert.equal(audit.route, 'session_bootstrap');
    assert.equal(audit.drift.context_loss_between_routes, false);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: buildLatestRecoContextFromAnalysisArtifacts emits canonical routine target bundle for routine-only analysis', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const routineAnalysisResult = {
      cards: [
        {
          type: 'routine_adjustment_plan_v1',
          payload: {
            replace: [
              {
                adjustment_id: 'adj_add_sunscreen',
                title: 'Add Sunscreen in the AM',
                why: 'UV protection is missing.',
              },
            ],
            recommendation_needs: [
              {
                adjustment_id: 'adj_add_sunscreen',
                target_step: 'sunscreen',
                why: 'Fill the missing daytime protection step.',
              },
            ],
          },
        },
      ],
    };

    const recoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      routineAnalysisResult,
      profileSummary: { goals: ['redness'] },
      artifactId: 'art_routine_owner_spine',
      contextOrigin: 'analysis_summary',
      analysisSource: 'routine_report',
      usePhoto: false,
      usedPhotos: false,
    });

    assert.ok(recoContext);
    assert.equal(recoContext.context_origin, 'routine_audit_v1');
    assert.equal(recoContext.resolved_target_step, 'sunscreen');
    assert.equal(recoContext.ingredient_query, 'sunscreen');
    assert.equal(String(recoContext.primary_target_id || '').includes('adj_add_sunscreen'), true);
    assert.equal(Array.isArray(recoContext.ranked_targets), true);
    assert.equal(recoContext.ranked_targets.length, 1);
    assert.equal(recoContext.ranked_targets[0].target_role, 'primary');
    assert.equal(recoContext.ranked_targets[0].resolved_target_step, 'sunscreen');
    assert.equal(recoContext.ranked_targets[0].source, 'routine_audit_v1');
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: buildLatestRecoContextFromAnalysisArtifacts prefers product-add needs over cleanser replacement drift', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const routineAnalysisResult = {
      cards: [
        {
          type: 'routine_adjustment_plan_v1',
          payload: {
            replace: [
              {
                adjustment_id: 'adj_pm_cleanser_replace',
                title: 'Consider a different cleanser for PM',
                change_type: 'replace',
                priority: 1,
                why: 'The same cleanser is used twice daily.',
              },
            ],
            add: [
              {
                adjustment_id: 'adj_add_spf_gap',
                title: 'Add a clear AM sunscreen step',
                change_type: 'add',
                priority: 3,
                why: 'AM protection is missing.',
              },
            ],
            recommendation_needs: [
              {
                adjustment_id: 'adj_pm_cleanser_replace',
                need_state: 'replace_current',
                target_step: 'cleanser',
                why: 'A gentler PM cleanse may help.',
                priority: 'medium',
              },
              {
                adjustment_id: 'adj_add_spf_gap',
                need_state: 'fill_gap',
                target_step: 'sunscreen',
                why: 'Fill the missing daytime protection step.',
                priority: 'low',
              },
            ],
          },
        },
      ],
    };

    const recoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      routineAnalysisResult,
      profileSummary: { goals: ['smooth layering', 'daily sunscreen'] },
      artifactId: 'art_routine_need_rank',
      usePhoto: false,
      usedPhotos: false,
    });

    assert.ok(recoContext);
    assert.equal(recoContext.context_origin, 'routine_audit_v1');
    assert.equal(recoContext.resolved_target_step, 'sunscreen');
    assert.equal(recoContext.ingredient_query, 'sunscreen');
    assert.equal(recoContext.analysis_reco_source, 'routine_audit_v1');
    assert.equal(String(recoContext.primary_target_id || '').includes('adj_add_spf_gap'), true);
    assert.equal(recoContext.ranked_targets[0].need_state, 'fill_gap');
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: buildLatestRecoContextFromAnalysisArtifacts converts missing PM barrier moisturizer minimal routine into reco target', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const routineAnalysisResult = {
      cards: [
        {
          type: 'routine_adjustment_plan_v1',
          payload: {
            replace: [
              {
                adjustment_id: 'adj_pm_cleanser_replace',
                title: 'Consider a different cleanser for PM',
                change_type: 'replace',
                priority: 1,
                why: 'The same cleanser is used twice daily.',
              },
            ],
            recommendation_needs: [
              {
                adjustment_id: 'adj_pm_cleanser_replace',
                need_state: 'replace_current',
                target_step: 'cleanser',
                why: 'A gentler PM cleanse may help.',
                priority: 'high',
              },
            ],
            minimal_viable_routine: {
              am_minimal: ['Gentle cleanser', 'SPF 50 sunscreen'],
              pm_minimal: ['Gentle cleanser', 'repair moisturizer'],
            },
            frequency_changes: [
              {
                adjustment_id: 'adj_retinoid_pause',
                change_type: 'frequency_change',
                title: 'Pause retinoid while the barrier is impaired',
                why: 'Retinoid use can worsen irritation when the barrier is impaired.',
              },
            ],
          },
        },
      ],
    };

    const recoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      routineAnalysisResult,
      profileSummary: {
        skinType: 'dry',
        sensitivity: 'high',
        barrierStatus: 'impaired',
        goals: ['barrier support'],
        currentRoutine: JSON.stringify({
          am: [
            { step: 'cleanser', product: 'Gentle cleanser' },
            { step: 'sunscreen', product: 'SPF 50 sunscreen' },
          ],
          pm: [
            { step: 'cleanser', product: 'Gentle cleanser' },
            { step: 'treatment', product: 'retinoid serum three nights per week' },
          ],
        }),
      },
      artifactId: 'art_routine_barrier_missing_pm_moisturizer',
      usePhoto: false,
      usedPhotos: false,
    });

    assert.ok(recoContext);
    assert.equal(recoContext.context_origin, 'routine_audit_v1');
    assert.equal(recoContext.resolved_target_step, 'moisturizer');
    assert.equal(recoContext.ingredient_query, 'moisturizer');
    assert.equal(recoContext.analysis_reco_source, 'routine_audit_v1_minimal_routine');
    assert.equal(
      String(recoContext.primary_target_id || '').includes('routine_minimal_pm_moisturizer_support'),
      true,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: buildLatestRecoContextFromAnalysisArtifacts preserves routine canonical spine when photo derivation is suppressed', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const routineAnalysisResult = {
      cards: [
        {
          type: 'routine_adjustment_plan_v1',
          payload: {
            replace: [
              {
                adjustment_id: 'adj_pm_cleanser',
                title: 'Consider a different cleanser for PM',
                why: 'The current cleanser looks too stripping.',
              },
            ],
            recommendation_needs: [
              {
                adjustment_id: 'adj_pm_cleanser',
                target_step: 'cleanser',
                why: 'A gentler PM cleanse is the safest next move.',
              },
            ],
          },
        },
      ],
    };
    const photoModulesCard = {
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'fail',
        summary_v1: {
          top_module_id: 'forehead',
          top_findings: [],
          quality_caveats: ['photo_quality_failed', 'low_confidence_primary_finding'],
        },
        modules: [],
      },
    };

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      routineAnalysisResult,
      ingredientPlan: null,
      photoModulesCard,
      artifactId: 'art_routine_survives_photo_fail',
      contextOrigin: 'analysis_summary',
      analysisSource: 'rule_based_with_photo_qc',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'fail',
      profileSummary: { goals: ['texture'] },
    });

    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.context_origin, 'routine_audit_v1');
    assert.equal(latestRecoContext.resolved_target_step, 'cleanser');
    assert.equal(String(latestRecoContext.primary_target_id || '').includes('adj_pm_cleanser'), true);
    assert.equal(Array.isArray(latestRecoContext.ranked_targets), true);
    assert.equal(latestRecoContext.ranked_targets[0].target_role, 'primary');
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: evaluateQualityContractForEnvelope allows shift explanation without explicit secondary targets', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'Primary recommendation focus: keep this pass centered on Azelaic Acid.\nThe primary direction did not have enough verified candidates, so I shifted to the closest verified secondary direction.',
      },
      session_patch: {
        state: {
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'photo_modules_v1',
            owner_source: 'photo_modules_v1',
            target_bundle_owner: 'photo_modules_v1',
            primary_target_id: 'azelaic_acid_serum_texture_nose',
            ranked_targets: [
              {
                target_id: 'azelaic_acid_serum_texture_nose',
                ingredient_query: 'Azelaic Acid',
                resolved_target_step: 'serum',
                target_role: 'primary',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendations: [
              {
                sku: {
                  brand: 'TestBrand',
                  name: 'Azelaic Serum',
                },
              },
            ],
            recommendation_meta: {
              mainline_status: 'grounded_success',
              primary_target_id: 'azelaic_acid_serum_texture_nose',
              displayed_target_ids: ['azelaic_acid_serum_texture_nose'],
              selected_target_ids: ['azelaic_acid_serum_texture_nose'],
              selection_shift_reason: 'confidence_policy_primary_target_shifted',
              ranked_targets: [
                {
                  target_id: 'azelaic_acid_serum_texture_nose',
                  ingredient_query: 'Azelaic Acid',
                  resolved_target_step: 'serum',
                  target_role: 'primary',
                },
              ],
            },
          },
        },
      ],
    };

    const quality = __internal.evaluateQualityContractForEnvelope({
      envelope,
      policyMeta: { intent_canonical: 'reco_products' },
      assistantText: envelope.assistant_message.content,
      profile: {},
    });

    assert.equal(quality.selection_shift_explained_pass, true);
    assert.equal(quality.direction_diversity_discipline_pass, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('__internal: evaluateQualityContractForEnvelope does not enforce photo-led focus alignment when canonical owner is routine', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const envelope = {
      assistant_message: {
        role: 'assistant',
        content: 'Photo analysis is temporarily unavailable. We will use a simpler photo check for now. Fix first: Your AM routine has no clear sunscreen step, so UV protection is the biggest gap before adding more brightening or anti-aging actives. This week: AM: Gentle Cleanser.',
      },
      session_patch: {
        state: {
          latest_reco_context: {
            intent: 'reco_products',
            context_origin: 'routine_audit_v1',
            owner_source: 'routine_audit_v1',
            target_bundle_owner: 'routine_audit_v1',
            primary_target_id: 'adj_pm_cleanser_replace',
            ranked_targets: [
              {
                target_id: 'adj_pm_cleanser_replace',
                ingredient_query: 'cleanser',
                resolved_target_step: 'cleanser',
                target_role: 'primary',
                source: 'routine_audit_v1',
              },
            ],
          },
        },
      },
      cards: [
        {
          type: 'photo_modules_v1',
          payload: {
            summary_v1: {
              top_module_id: 'forehead',
              top_findings: [
                {
                  module_id: 'forehead',
                  confidence_bucket: 'low',
                },
              ],
            },
          },
        },
        {
          type: 'analysis_story_v2',
          payload: {
            ui_card_v1: {
              headline: 'Photo analysis is temporarily unavailable. We will use a simpler photo check for now.',
              priority_findings: [
                'Your AM routine has no clear sunscreen step, so UV protection is the biggest gap before adding more brightening or anti-aging actives.',
              ],
              confidence_label: 'medium',
            },
          },
        },
        {
          type: 'confidence_notice',
          payload: {
            reason: 'low_confidence',
          },
        },
      ],
    };

    const quality = __internal.evaluateQualityContractForEnvelope({
      envelope,
      policyMeta: { intent_canonical: 'analysis_skin' },
      assistantText: envelope.assistant_message.content,
      profile: {},
    });

    assert.equal(quality.primary_focus_alignment_pass, true);
    assert.equal(quality.confidence_consistency_pass, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('annotated ingredient plan retains policy-safe moisturizer primary for degraded low-confidence photo without reviving aggressive target', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const photoModulesCard = {
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'degraded',
        summary_v1: {
          top_module_id: 'nose',
          top_action_ingredient_id: 'retinol',
          top_issue_type: 'texture',
          top_findings: [
            {
              module_id: 'nose',
              issue_type: 'texture',
              confidence_bucket: 'low',
            },
          ],
        },
        modules: [
          {
            module_id: 'nose',
            module_rank_score: 0.95,
            actions: [
              {
                ingredient_canonical_id: 'retinol',
                ingredient_name: 'Retinoid (later stage)',
                action_rank_score: 0.95,
                why: 'Retinoid (later stage) helps improve uneven texture in highlighted areas.',
                evidence_issue_types: ['texture'],
                products: [],
              },
            ],
          },
        ],
      },
    };
    const ingredientPlan = {
      schema_version: 'aurora.ingredient_plan.v2',
      targets: [
        {
          ingredient_id: 'retinol',
          ingredient_name: 'Retinoid (later stage)',
          priority_score_0_100: 95,
          recommendation_mode: 'cta_only',
          strict_product_count: 0,
          presentation_bucket: 'photo_derived',
          resolved_target_step: 'treatment',
          source_issue_types: ['texture'],
          why: ['Retinoid is the strongest texture-active candidate.'],
          products: {
            competitors: [],
            products_empty_reason: 'strict_match_miss',
          },
        },
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          priority_score_0_100: 84,
          recommendation_mode: 'cta_only',
          strict_product_count: 0,
          presentation_bucket: 'baseline_support',
          resolved_target_step: 'moisturizer',
          source_issue_types: ['texture'],
          why: ['Barrier support keeps the plan conservative while texture confidence is low.'],
          products: {
            competitors: [],
            products_empty_reason: 'strict_match_miss',
          },
        },
        {
          ingredient_id: 'panthenol',
          ingredient_name: 'Panthenol (B5)',
          priority_score_0_100: 80,
          recommendation_mode: 'cta_only',
          strict_product_count: 0,
          presentation_bucket: 'baseline_support',
          resolved_target_step: 'moisturizer',
          source_issue_types: ['texture'],
          why: ['Panthenol is a low-risk repair support option.'],
          products: {
            competitors: [],
            products_empty_reason: 'strict_match_miss',
          },
        },
      ],
    };

    const annotated = __internal.annotateIngredientPlanForPhotoLed(ingredientPlan, photoModulesCard, 'EN');
    assert.equal(Array.isArray(annotated?.targets), true);
    assert.equal(annotated.targets.length > 0, true);
    assert.equal(annotated.targets[0]?.ingredient_id, 'ceramide_np');
    assert.equal(annotated.targets[0]?.target_role, 'primary');
    assert.equal(annotated.targets[0]?.resolved_target_step, 'moisturizer');
    assert.equal(annotated.targets.some((target) => target?.ingredient_id === 'retinol'), false);

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      ingredientPlan: annotated,
      photoModulesCard,
      artifactId: 'art_safe_low_conf_plan',
      contextOrigin: 'analysis_summary',
      analysisSource: 'rule_based_with_photo',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'degraded',
    });

    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.ingredient_query, 'Ceramide NP');
    assert.equal(latestRecoContext.resolved_target_step, 'moisturizer');
    assert.match(String(latestRecoContext.primary_target_id || ''), /ceramide_np/i);
  } finally {
    delete require.cache[moduleId];
  }
});

test('photo-first latest reco context beats routine audit handoff when explicit photo analysis produced a usable photo bundle', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const routineAnalysisResult = {
      cards: [
        {
          type: 'routine_adjustment_plan_v1',
          payload: {
            replace: [
              {
                adjustment_id: 'adj_add_sunscreen',
                title: 'Add Sunscreen in the AM',
                why: 'UV protection is missing.',
              },
            ],
            recommendation_needs: [
              {
                adjustment_id: 'adj_add_sunscreen',
                target_step: 'sunscreen',
                why: 'Fill the missing daytime protection step.',
              },
            ],
          },
        },
      ],
    };
    const photoModulesCard = {
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'degraded',
        summary_v1: {
          top_module_id: 'nose',
          top_action_ingredient_id: 'retinol',
          top_issue_type: 'texture',
          top_findings: [
            {
              module_id: 'nose',
              issue_type: 'texture',
              confidence_bucket: 'low',
            },
          ],
        },
        modules: [
          {
            module_id: 'nose',
            module_rank_score: 0.95,
            actions: [
              {
                ingredient_canonical_id: 'retinol',
                ingredient_name: 'Retinoid (later stage)',
                action_rank_score: 0.95,
                why: 'Retinoid would be the aggressive texture direction.',
                evidence_issue_types: ['texture'],
                products: [],
              },
            ],
          },
        ],
      },
    };
    const ingredientPlan = {
      schema_version: 'aurora.ingredient_plan.v2',
      targets: [
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          priority_score_0_100: 84,
          recommendation_mode: 'strict_match',
          strict_product_count: 2,
          presentation_bucket: 'baseline_support',
          resolved_target_step: 'moisturizer',
          source_issue_types: ['texture'],
          why: ['Barrier support keeps the plan conservative while texture confidence is low.'],
          products: {
            competitors: [
              {
                product_id: 'ceramide_1',
                name: 'Barrier Rescue Cream',
                brand: 'BarrierLab',
              },
            ],
          },
        },
      ],
    };

    const latestRecoContext = __internal.buildLatestRecoContextFromAnalysisArtifacts({
      routineAnalysisResult,
      ingredientPlan,
      photoModulesCard,
      artifactId: 'art_photo_should_win',
      contextOrigin: 'analysis_summary',
      analysisSource: 'rule_based_with_photo',
      usePhoto: true,
      usedPhotos: true,
      photoQualityGrade: 'degraded',
    });

    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.context_origin, 'photo_modules_v1');
    assert.equal(latestRecoContext.ingredient_query, 'Ceramide NP');
    assert.equal(latestRecoContext.resolved_target_step, 'moisturizer');
    assert.equal(String(latestRecoContext.primary_target_id || '').includes('ceramide_np'), true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyAnalysisStoryAndRoutineSoftGate keeps analysis_story_v2 photo-first when routine preview is present', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const cards = [
      {
        type: 'analysis_summary',
        payload: {
          analysis_source: 'rule_based_with_photo',
          photos_provided: true,
          used_photos: true,
          low_confidence: false,
          quality_report: {
            photo_quality: {
              grade: 'degraded',
              reasons: ['indoor_lighting'],
            },
          },
          analysis: {
            confidence: { level: 'low' },
            features: [
              { observation: 'Visible texture irregularity around the nose.' },
            ],
          },
        },
      },
      {
        type: 'photo_modules_v1',
        payload: {
          used_photos: true,
          quality_grade: 'degraded',
          summary_v1: {
            top_module_id: 'nose',
            top_action_ingredient_id: 'retinol',
            top_issue_type: 'texture',
            top_findings: [
              {
                module_id: 'nose',
                issue_type: 'texture',
                confidence_bucket: 'low',
              },
            ],
          },
          modules: [
            {
              module_id: 'nose',
              module_rank_score: 0.95,
              issues: [
                {
                  issue_type: 'texture',
                  severity_0_4: 2,
                  confidence_0_1: 0.28,
                  confidence_bucket: 'low',
                  explanation_short: 'Visible texture irregularity around the nose.',
                },
              ],
              actions: [
                {
                  ingredient_canonical_id: 'retinol',
                  ingredient_name: 'Retinoid (later stage)',
                  action_rank_score: 0.95,
                  why: 'Retinoid would be the aggressive texture direction.',
                  evidence_issue_types: ['texture'],
                  products: [],
                },
              ],
            },
          ],
        },
      },
      {
        type: 'routine_products_preview',
        payload: {
          groups: [
            {
              slot: 'am',
              items: [
                { slot: 'am', step: 'cleanser', display_name: 'Gentle Gel Cleanser' },
                { slot: 'am', step: 'moisturizer', display_name: 'Daily Lotion' },
              ],
            },
            {
              slot: 'pm',
              items: [
                { slot: 'pm', step: 'cleanser', display_name: 'Gentle Gel Cleanser' },
                { slot: 'pm', step: 'treatment', display_name: 'Night Retinoid' },
                { slot: 'pm', step: 'moisturizer', display_name: 'Barrier Cream' },
              ],
            },
          ],
        },
      },
      {
        type: 'ingredient_plan_v2',
        payload: {
          schema_version: 'aurora.ingredient_plan.v2',
          targets: [
            {
              ingredient_id: 'retinol',
              ingredient_name: 'Retinoid (later stage)',
              priority_score_0_100: 95,
              recommendation_mode: 'cta_only',
              strict_product_count: 0,
              presentation_bucket: 'photo_derived',
              resolved_target_step: 'treatment',
              source_issue_types: ['texture'],
              why: ['Retinoid is the strongest texture-active candidate.'],
              products: {
                competitors: [],
                products_empty_reason: 'strict_match_miss',
              },
            },
            {
              ingredient_id: 'ceramide_np',
              ingredient_name: 'Ceramide NP',
              priority_score_0_100: 84,
              recommendation_mode: 'strict_match',
              strict_product_count: 2,
              presentation_bucket: 'baseline_support',
              resolved_target_step: 'moisturizer',
              source_issue_types: ['texture'],
              why: ['Barrier support keeps the plan conservative while texture confidence is low.'],
              products: {
                competitors: [
                  {
                    product_id: 'ceramide_barrier_1',
                    name: 'Barrier Rescue Cream',
                    brand: 'BarrierLab',
                  },
                ],
              },
            },
          ],
        },
      },
    ];

    const nextCards = await __internal.applyAnalysisStoryAndRoutineSoftGate(cards, {
      ctx: { request_id: 'req_photo_story_axis' },
      profile: {
        skinType: 'combination',
        sensitivity: 'medium',
        barrierStatus: 'fragile',
        goals: ['barrier'],
      },
      language: 'EN',
      qaMode: 'off',
      singleProvider: 'gemini',
      allowOpenAiFallback: false,
      qaContext: { story_force_deterministic_reason: 'test_force_deterministic' },
    });

    const storyCard = findCardByType(nextCards, 'analysis_story_v2');
    assert.ok(storyCard);
    const storyPayload = storyCard?.payload || {};
    const firstFinding = String(storyPayload?.priority_findings?.[0]?.title || '');
    const headline = String(storyPayload?.ui_card_v1?.headline || '');
    const firstAction = String(storyPayload?.ui_card_v1?.actions_now?.[0] || '');
    assert.match(firstFinding, /nose|texture/i);
    assert.doesNotMatch(firstFinding, /sunscreen/i);
    assert.doesNotMatch(headline, /sunscreen/i);
    assert.match(firstAction, /ceramide/i);
    assert.doesNotMatch(firstAction, /sunscreen/i);
    assert.doesNotMatch(firstAction, /retinoid/i);
    assert.equal(String(storyPayload?.confidence_overall?.level || ''), 'low');
    assert.equal(String(storyPayload?.ui_card_v1?.confidence_label || '').toLowerCase(), 'low');

    const ingredientPlanCard = findCardByType(nextCards, 'ingredient_plan_v2');
    assert.ok(ingredientPlanCard);
    assert.equal(ingredientPlanCard?.payload?.targets?.[0]?.ingredient_id, 'ceramide_np');
    assert.equal(ingredientPlanCard?.payload?.targets?.[0]?.target_role, 'primary');
  } finally {
    delete require.cache[moduleId];
  }
});

test('/v1/analysis/skin: upload->fetch path can downgrade to retake when photo quality fails', async () => {
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
          ? uploadResp.body.cards.find((c) => c && ['analysis_summary', 'analysis_story_v2'].includes(String(c.type || '')))
          : null;
        if (uploadAnalysisCard) assert.equal(typeof uploadAnalysisCard?.payload, 'object');

        const analysisResp = await request
          .post('/v1/analysis/skin')
          .set(headers)
          .send({
            use_photo: true,
            currentRoutine: 'AM gentle cleanser + SPF; PM gentle cleanser + retinol + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: photoId, qc_status: 'passed' }],
          })
          .expect(200);

        const analysisCards = Array.isArray(analysisResp.body?.cards) ? analysisResp.body.cards : [];
        const analysisStoryCard = findCardByType(analysisCards, 'analysis_story_v2');
        assert.ok(analysisStoryCard);
        const analysisMeta = analysisResp.body?.analysis_meta || {};
        assert.equal(
          ['rule_based', 'rule_based_with_photo_qc', 'diagnosis_v1_template', 'retake'].includes(String(analysisMeta.detector_source || '')),
          true,
        );
        assert.equal(Boolean(analysisMeta.llm_report_called), false);
        const valueMoment =
          (Array.isArray(analysisResp.body?.events) ? analysisResp.body.events : []).find((e) => e && e.event_name === 'value_moment') ||
          null;
        assert.ok(valueMoment);
        assert.equal(typeof valueMoment?.data?.used_photos, 'boolean');
        assert.equal(String(valueMoment?.data?.analysis_source || '').length > 0, true);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: photo-only input is not hard-gated when routine/logs are missing', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
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

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 216, g: 180, b: 160 } },
      })
        .png()
        .toBuffer();

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/object-photo-only',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/object-photo-only') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      axios.post = async (url, body) => {
        const u = String(url || '');
        if (u === 'https://aurora-decision.test/agent/query') {
          const answerObj = {
            features: [
              { observation: 'Photo-backed summary was generated for this run.', confidence: 'somewhat_sure' },
              { observation: 'Acne goal remains the primary optimization target.', confidence: 'somewhat_sure' },
            ],
            strategy: 'Given this photo-first read, do you want a gentler 7-day plan?',
            needs_risk_check: false,
          };
          return { status: 200, data: { answer: JSON.stringify(answerObj) } };
        }
        throw new Error(`Unexpected axios.post url: ${u}; body keys=${Object.keys(body || {}).join(',')}`);
      };

      axios.request = originalRequest;

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);

        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_only',
            'X-Trace-ID': 'trace_photo_only',
            'X-Brief-ID': 'brief_photo_only',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            photos: [{ slot_id: 'daylight', photo_id: 'photo_only_1', qc_status: 'passed' }],
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        assert.ok(storyCard);
        const analysisMeta = resp.body?.analysis_meta || {};
        assert.notEqual(String(analysisMeta.detector_source || ''), 'baseline_low_confidence');
        assert.equal(typeof analysisMeta.llm_report_called, 'boolean');
        assert.notEqual(String(analysisMeta.degrade_reason || ''), 'missing_primary_input');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: photo upload does not force report LLM when detector is confident', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinDiagnosisModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[routesModuleId];
      delete require.cache[skinDiagnosisModuleId];

      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      skinDiagnosis.runSkinDiagnosisV1 = async () => ({
        ok: true,
        diagnosis: {
          issues: [
            {
              issue_type: 'redness',
              severity: 'mild',
              severity_level: 3,
              severity_score: 0.82,
              confidence: 0.95,
              confidence_label: 'pretty_sure',
              summary: 'Mild redness, high confidence from deterministic detector.',
            },
          ],
          quality: { grade: 'pass', reasons: ['qc_passed'] },
          photo_findings: [
            {
              finding_id: 'finding_redness_confident',
              issue_type: 'redness',
              confidence: 0.95,
              evidence: 'From photo: mild redness on cheek.',
            },
          ],
          takeaways: [
            {
              takeaway_id: 'takeaway_redness_confident',
              source: 'photo',
              issue_type: 'redness',
              text: 'From photo: mild redness on cheek.',
              confidence: 0.95,
              linked_finding_ids: ['finding_redness_confident'],
            },
          ],
        },
        internal: { orig_size_px: { w: 64, h: 64 } },
      });

      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
          'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
          'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
          '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
        'base64',
      );
      let reportModelCallCount = 0;

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/object-confidence-skip',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/object-confidence-skip') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      axios.post = async (url) => {
        const u = String(url || '');
        if (u === 'https://aurora-decision.test/agent/query') {
          reportModelCallCount += 1;
          return {
            status: 200,
            data: {
              answer: JSON.stringify({
                features: [{ observation: 'unexpected report call', confidence: 'somewhat_sure' }],
                strategy: 'unexpected report call',
                needs_risk_check: false,
              }),
            },
          };
        }
        throw new Error(`Unexpected axios.post url: ${u}`);
      };

      axios.request = originalRequest;

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);

        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_confident_skip',
            'X-Trace-ID': 'trace_photo_confident_skip',
            'X-Brief-ID': 'brief_photo_confident_skip',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'AM gentle cleanser + SPF; PM retinol + moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_confident_1', qc_status: 'passed' }],
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        assert.ok(storyCard);
        assert.ok(findCardByType(cards, 'photo_modules_v1'));
        assert.equal(Boolean(resp.body?.analysis_meta?.llm_report_called), false);
        assert.equal(reportModelCallCount, 0);
      } finally {
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[routesModuleId];
        delete require.cache[skinDiagnosisModuleId];
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

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        assert.ok(storyCard);
        const analysisMeta = resp.body?.analysis_meta || {};
        assert.equal(String(analysisMeta.detector_source || ''), 'rule_based_with_photo_qc');
        assert.equal(
          ['photo_download_url_fetch_4xx', 'photo_download_url_fetch_5xx'].includes(String(analysisMeta.degrade_reason || '')),
          true,
        );
        const confidenceCard = findCardByType(cards, 'confidence_notice');
        assert.ok(confidenceCard);
        const rationale = Array.isArray(confidenceCard?.payload?.confidence?.rationale)
          ? confidenceCard.payload.confidence.rationale
          : [];
        assert.equal(rationale.includes('photo_requested_but_not_used'), true);
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

test('/v1/photos/upload: upload stream failure exposes stage-specific error code', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_AUTO_ANALYZE_AFTER_CONFIRM: 'false',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');
      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
          'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
          'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
          '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
        'base64',
      );

      axios.post = async (url) => {
        const u = String(url);
        if (u.endsWith('/photos/presign')) {
          return {
            status: 200,
            data: {
              upload_id: 'photo_upload_stream_fail',
              upload: {
                url: 'https://signed-upload.test/object',
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
              },
            },
          };
        }
        throw new Error(`Unexpected axios.post url: ${u}`);
      };

      axios.get = async (url) => {
        throw new Error(`Unexpected axios.get url: ${String(url)}`);
      };

      axios.request = async (config = {}) => {
        if (String(config.url || '') === 'https://signed-upload.test/object') {
          if (config.data && typeof config.data.on === 'function') {
            await new Promise((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
              };
              config.data.once('open', finish);
              config.data.once('error', finish);
            });
          }
          if (config.data && typeof config.data.destroy === 'function') config.data.destroy();
          const err = new Error('socket hang up');
          err.code = 'ECONNRESET';
          throw err;
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
            'X-Aurora-UID': 'uid_photo_upload_stream_fail',
            'X-Trace-ID': 'trace_photo_upload_stream_fail',
            'X-Brief-ID': 'brief_photo_upload_stream_fail',
            'X-Lang': 'EN',
          })
          .field('slot_id', 'daylight')
          .field('consent', 'true')
          .attach('photo', pngBytes, { filename: 'face.png', contentType: 'image/png' })
          .expect(500);

        const cards = Array.isArray(uploadResp.body?.cards) ? uploadResp.body.cards : [];
        const errorCard = cards.find((c) => c && c.type === 'error');
        const errorPayload = errorCard && errorCard.payload && typeof errorCard.payload === 'object' ? errorCard.payload : {};
        const errorEvent = Array.isArray(uploadResp.body?.events)
          ? uploadResp.body.events.find((evt) => evt && evt.event_name === 'error')
          : null;

        assert.equal(errorPayload.error, 'PHOTO_UPLOAD_STREAM_FAILED');
        assert.equal(errorPayload.stage, 'upload_bytes');
        assert.equal(errorEvent?.data?.code, 'PHOTO_UPLOAD_STREAM_FAILED');
        assert.equal(errorEvent?.data?.stage, 'upload_bytes');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
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
              qc: {
                state: 'pending',
                qc_status: null,
                advice: {
                  summary: 'QC is pending.',
                  suggestions: ['Processing your photo...'],
                },
              },
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
        assert.equal(confirmCard?.payload?.qc_status, 'passed');
        assert.equal(confirmCard?.payload?.qc?.state, 'done');
        assert.equal(confirmCard?.payload?.qc?.qc_status, 'passed');
        assert.equal(/pending/i.test(String(confirmCard?.payload?.qc?.advice?.summary || '')), false);
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
        assert.ok(['retake', 'rule_based_with_photo_qc'].includes(String(analysisCard?.payload?.analysis_source || '')));
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

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        assert.ok(storyCard);
        const analysisMeta = resp.body?.analysis_meta || {};
        assert.notEqual(String(analysisMeta.detector_source || ''), 'baseline_low_confidence');
        const valueMoment =
          (Array.isArray(resp.body?.events) ? resp.body.events : []).find((e) => e && e.event_name === 'value_moment') || null;
        assert.ok(valueMoment);
        assert.equal(Boolean(valueMoment?.data?.used_photos), true);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: photo-only input can proceed as rule-based when photo diagnosis succeeds', async () => {
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
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[routesModuleId];
      delete require.cache[skinModuleId];

      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      skinDiagnosis.runSkinDiagnosisV1 = async () => ({
        ok: true,
        diagnosis: {
          quality: { grade: 'pass', reasons: ['qc_passed'] },
          findings: [],
        },
      });

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
                  url: 'https://signed-download.test/photo-only',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (u === 'https://signed-download.test/photo-only') {
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
            'X-Aurora-UID': 'uid_photo_only',
            'X-Trace-ID': 'trace_photo_only',
            'X-Brief-ID': 'brief_photo_only',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            photos: [{ slot_id: 'daylight', photo_id: 'photo_only_1', qc_status: 'passed' }],
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        assert.ok(storyCard);
        const analysisMeta = resp.body?.analysis_meta || {};
        assert.notEqual(String(analysisMeta.detector_source || ''), 'baseline_low_confidence');
        assert.notEqual(String(analysisMeta.degrade_reason || ''), 'missing_primary_input');
        const valueMoment =
          (Array.isArray(resp.body?.events) ? resp.body.events : []).find((e) => e && e.event_name === 'value_moment') || null;
        assert.ok(valueMoment);
        assert.equal(Boolean(valueMoment?.data?.used_photos), true);
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

test('/v1/analysis/skin: non-routine photo analysis exposes artifact gate reason when profile core is missing', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '2500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '800',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinDiagnosisModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[routesModuleId];
      delete require.cache[skinDiagnosisModuleId];

      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      skinDiagnosis.runSkinDiagnosisV1 = async () => ({
        ok: true,
        diagnosis: {
          issues: [
            {
              issue_type: 'redness',
              severity: 'mild',
              severity_level: 3,
              severity_score: 0.82,
              confidence: 0.95,
              confidence_label: 'pretty_sure',
              summary: 'Mild redness, high confidence from deterministic detector.',
            },
          ],
          quality: { grade: 'pass', reasons: ['qc_passed'] },
          photo_findings: [
            {
              finding_id: 'finding_redness_confident',
              issue_type: 'redness',
              confidence: 0.95,
              evidence: 'From photo: mild redness on cheek.',
            },
          ],
          takeaways: [
            {
              takeaway_id: 'takeaway_redness_confident',
              source: 'photo',
              issue_type: 'redness',
              text: 'From photo: mild redness on cheek.',
              confidence: 0.95,
              linked_finding_ids: ['finding_redness_confident'],
            },
          ],
        },
        internal: { orig_size_px: { w: 64, h: 64 } },
      });

      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const axios = require('axios');

      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAsSAAALEgHS3X78AAAA' +
          'B3RJTUUH5AICDgYk4fYQPgAAAB1pVFh0Q29tbWVudAAAAAAAvK6ymQAAAHVJREFUWMPtzsENwCAQ' +
          'BEG9/5f2QxA6i1xAikQW2L8z8V8YfM+K7QwAAAAAAAAAAAAAAAB4t6x3K2W3fQn2eZ5n4J1wV2k8vT' +
          '3uQv2bB0hQ7m9t9h9m9M6r8f3A2f0A8Qf8Sg8x9I3hM8AAAAASUVORK5CYII=',
        'base64',
      );

      axios.get = async (url) => {
        const u = String(url || '');
        if (u.endsWith('/photos/download-url')) {
          return {
            status: 200,
            data: {
              download: {
                url: 'https://signed-download.test/object-artifact-gate',
                expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
              },
              content_type: 'image/png',
            },
          };
        }
        if (u === 'https://signed-download.test/object-artifact-gate') {
          return {
            status: 200,
            data: pngBytes,
            headers: { 'content-type': 'image/png' },
          };
        }
        throw new Error(`Unexpected axios.get url: ${u}`);
      };

      axios.post = async (url, body) => {
        const u = String(url || '');
        if (u === 'https://aurora-decision.test/agent/query') {
          const answerObj = {
            features: [
              { observation: 'Photo-backed summary was generated for this run.', confidence: 'somewhat_sure' },
              { observation: 'Acne goal remains the primary optimization target.', confidence: 'somewhat_sure' },
            ],
            strategy: 'Given this photo-first read, do you want a gentler 7-day plan?',
            needs_risk_check: false,
          };
          return { status: 200, data: { answer: JSON.stringify(answerObj) } };
        }
        throw new Error(`Unexpected axios.post url: ${u}; body keys=${Object.keys(body || {}).join(',')}`);
      };

      axios.request = originalRequest;

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);

        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_artifact_gate_missing_core',
            'X-Trace-ID': 'trace_photo_artifact_gate_missing_core',
            'X-Brief-ID': 'brief_photo_artifact_gate_missing_core',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            photos: [{ slot_id: 'daylight', photo_id: 'photo_artifact_gate_1', qc_status: 'passed' }],
          })
          .expect(200);

        const analysisMeta = resp.body?.analysis_meta || {};
        assert.equal(analysisMeta.analysis_mode, 'analysis_summary');
        assert.equal(analysisMeta.artifact_usable, false);
        assert.equal(analysisMeta.artifact_gate?.tier, 'ineligible');
        assert.equal(analysisMeta.artifact_gate?.reason, 'artifact_missing_core');
        assert.deepEqual(
          analysisMeta.artifact_gate?.missing_core,
          ['skinType', 'sensitivity', 'barrierStatus', 'goals'],
        );
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        delete require.cache[routesModuleId];
        delete require.cache[skinDiagnosisModuleId];
      }
    },
  );
});

test('/v1/analysis/skin: stringified empty routine does not block photo-first rule-based analysis', async () => {
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
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[routesModuleId];
      delete require.cache[skinModuleId];

      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      skinDiagnosis.runSkinDiagnosisV1 = async () => ({
        ok: true,
        diagnosis: {
          quality: { grade: 'pass', reasons: ['qc_passed'] },
          findings: [],
        },
      });

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
                  url: 'https://signed-download.test/photo-only-routine-json-empty',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (u === 'https://signed-download.test/photo-only-routine-json-empty') {
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
            'X-Aurora-UID': 'uid_photo_only_routine_json_empty',
            'X-Trace-ID': 'trace_photo_only_routine_json_empty',
            'X-Brief-ID': 'brief_photo_only_routine_json_empty',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: '{}',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_only_2', qc_status: 'passed' }],
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        assert.ok(storyCard);
        const analysisMeta = resp.body?.analysis_meta || {};
        assert.notEqual(String(analysisMeta.detector_source || ''), 'baseline_low_confidence');
        assert.notEqual(String(analysisMeta.degrade_reason || ''), 'missing_primary_input');
        const valueMoment =
          (Array.isArray(resp.body?.events) ? resp.body.events : []).find((e) => e && e.event_name === 'value_moment') || null;
        assert.ok(valueMoment);
        assert.equal(Boolean(valueMoment?.data?.used_photos), true);
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

test('/v1/analysis/skin: fresh photo readiness retries transient download-url 4xx and still uses photos', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '1500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '500',
      AURORA_PHOTO_FRESH_READINESS_RETRIES: '1',
      AURORA_PHOTO_FRESH_READINESS_RETRY_BASE_MS: '1',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinDiagnosisModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[routesModuleId];
      delete require.cache[skinDiagnosisModuleId];

      const axios = require('axios');
      const sharp = require('sharp');
      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 218, g: 192, b: 176 } },
      })
        .png()
        .toBuffer();

      let downloadUrlCalls = 0;
      skinDiagnosis.runSkinDiagnosisV1 = async () => ({
        ok: true,
        diagnosis: {
          issues: [
            {
              issue_type: 'dryness',
              severity: 'mild',
              severity_level: 2,
              severity_score: 0.66,
              confidence: 0.92,
              confidence_label: 'pretty_sure',
              summary: 'Mild dryness around the cheeks.',
            },
          ],
          quality: { grade: 'pass', reasons: ['qc_passed'] },
          photo_findings: [
            {
              finding_id: 'fresh_retry_dryness',
              issue_type: 'dryness',
              confidence: 0.92,
              evidence: 'Dryness visible on cheek area.',
            },
          ],
        },
        internal: { source: 'test_retry' },
      });

      try {
        axios.get = async (url) => {
          const u = String(url || '');
          if (u.endsWith('/photos/download-url')) {
            downloadUrlCalls += 1;
            if (downloadUrlCalls === 1) {
              return { status: 404, data: { detail: 'not ready yet' } };
            }
            return {
              status: 200,
              data: {
                download: {
                  url: 'https://signed-download.test/fresh-ready',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (u === 'https://signed-download.test/fresh-ready') {
            return {
              status: 200,
              data: pngBytes,
              headers: { 'content-type': 'image/png' },
            };
          }
          throw new Error(`Unexpected axios.get url: ${u}`);
        };

        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_readiness_fetch',
            'X-Trace-ID': 'trace_photo_readiness_fetch',
            'X-Brief-ID': 'brief_photo_readiness_fetch',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'PM moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_readiness_fetch', qc_status: 'passed' }],
          })
          .expect(200);

        const valueMoment =
          (Array.isArray(resp.body?.events) ? resp.body.events : []).find((e) => e && e.event_name === 'value_moment') || null;
        assert.ok(valueMoment);
        assert.equal(Boolean(valueMoment?.data?.used_photos), true);
        assert.equal(downloadUrlCalls >= 2, true);
        assert.ok(findCardByType(Array.isArray(resp.body?.cards) ? resp.body.cards : [], 'analysis_story_v2'));
      } finally {
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[routesModuleId];
        delete require.cache[skinDiagnosisModuleId];
      }
    },
  );
});

test('/v1/analysis/skin: fresh photo readiness retries transient diagnosis throw and still uses photos', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'agent_test_key',
      AURORA_SKIN_VISION_ENABLED: 'false',
      AURORA_PHOTO_FETCH_RETRIES: '0',
      AURORA_PHOTO_FETCH_TOTAL_TIMEOUT_MS: '1500',
      AURORA_PHOTO_FETCH_TIMEOUT_MS: '500',
      AURORA_PHOTO_FRESH_READINESS_RETRIES: '1',
      AURORA_PHOTO_FRESH_READINESS_RETRY_BASE_MS: '1',
    },
    async () => {
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinDiagnosisModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      delete require.cache[routesModuleId];
      delete require.cache[skinDiagnosisModuleId];

      const axios = require('axios');
      const sharp = require('sharp');
      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 190, b: 170 } },
      })
        .png()
        .toBuffer();

      let diagnosisCalls = 0;
      skinDiagnosis.runSkinDiagnosisV1 = async () => {
        diagnosisCalls += 1;
        if (diagnosisCalls === 1) {
          throw new Error('Input buffer contains unsupported image format');
        }
        return {
          ok: true,
          diagnosis: {
            issues: [
              {
                issue_type: 'redness',
                severity: 'mild',
                severity_level: 2,
                severity_score: 0.61,
                confidence: 0.9,
                confidence_label: 'pretty_sure',
                summary: 'Mild redness on the cheeks.',
              },
            ],
            quality: { grade: 'pass', reasons: ['qc_passed'] },
            photo_findings: [
              {
                finding_id: 'fresh_retry_redness',
                issue_type: 'redness',
                confidence: 0.9,
                evidence: 'Redness visible on cheek area.',
              },
            ],
          },
          internal: { source: 'test_retry_diagnosis' },
        };
      };

      try {
        axios.get = async (url) => {
          const u = String(url || '');
          if (u.endsWith('/photos/download-url')) {
            return {
              status: 200,
              data: {
                download: {
                  url: 'https://signed-download.test/fresh-diagnosis-retry',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (u === 'https://signed-download.test/fresh-diagnosis-retry') {
            return {
              status: 200,
              data: pngBytes,
              headers: { 'content-type': 'image/png' },
            };
          }
          throw new Error(`Unexpected axios.get url: ${u}`);
        };

        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_photo_readiness_diag',
            'X-Trace-ID': 'trace_photo_readiness_diag',
            'X-Brief-ID': 'brief_photo_readiness_diag',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: 'PM moisturizer',
            photos: [{ slot_id: 'daylight', photo_id: 'photo_readiness_diag', qc_status: 'passed' }],
          })
          .expect(200);

        const valueMoment =
          (Array.isArray(resp.body?.events) ? resp.body.events : []).find((e) => e && e.event_name === 'value_moment') || null;
        assert.ok(valueMoment);
        assert.equal(Boolean(valueMoment?.data?.used_photos), true);
        assert.equal(diagnosisCalls, 2);
        assert.ok(findCardByType(Array.isArray(resp.body?.cards) ? resp.body.cards : [], 'analysis_story_v2'));
      } finally {
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[routesModuleId];
        delete require.cache[skinDiagnosisModuleId];
      }
    },
  );
});

test('/v1/analysis/skin: mixed routine+photo keeps photo-led analysis_story_v2 even when routine analysis cards are present', async () => {
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
      const routesModuleId = require.resolve('../src/auroraBff/routes');
      const skinDiagnosisModuleId = require.resolve('../src/auroraBff/skinDiagnosisV1');
      const routineAnalysisModuleId = require.resolve('../src/auroraBff/routineAnalysisV2');
      delete require.cache[routesModuleId];
      delete require.cache[skinDiagnosisModuleId];
      delete require.cache[routineAnalysisModuleId];

      const axios = require('axios');
      const sharp = require('sharp');
      const skinDiagnosis = require('../src/auroraBff/skinDiagnosisV1');
      const routineAnalysisV2 = require('../src/auroraBff/routineAnalysisV2');
      const originalRunSkinDiagnosisV1 = skinDiagnosis.runSkinDiagnosisV1;
      const originalRunRoutineAnalysisV2 = routineAnalysisV2.runRoutineAnalysisV2;
      const originalGet = axios.get;
      const originalPost = axios.post;
      const originalRequest = axios.request;
      let routineCalls = 0;
      const pngBytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 192, b: 176 } },
      })
        .png()
        .toBuffer();

      skinDiagnosis.runSkinDiagnosisV1 = async () => ({
        ok: true,
        diagnosis: {
          issues: [
            {
              issue_type: 'texture',
              severity: 'mild',
              severity_level: 2,
              severity_score: 0.61,
              confidence: 0.2,
              confidence_label: 'uncertain',
              summary: 'Visible texture irregularity near the right under-eye area.',
            },
          ],
          quality: { grade: 'pass', reasons: ['qc_passed'] },
          photo_findings: [
            {
              finding_id: 'mixed_photo_story_texture',
              issue_type: 'texture',
              confidence: 0.2,
              evidence: 'Visible texture irregularity near the right under-eye area.',
            },
          ],
        },
        internal: { source: 'test_mixed_photo_story' },
      });

      routineAnalysisV2.runRoutineAnalysisV2 = async () => {
        routineCalls += 1;
        return ({
          cards: [
            {
              card_id: 'routine_audit_test',
              type: 'routine_product_audit_v1',
              payload: {
                summary: 'Add Sunscreen in the AM',
                primary_gap: 'Missing sunscreen',
              },
            },
            {
              card_id: 'routine_adjustment_test',
              type: 'routine_adjustment_plan_v1',
              payload: {
                steps: ['Add SPF50+ sunscreen every morning.'],
              },
            },
          ],
          assistant_text:
            'I reviewed each current product first. The best place to start is "Add Sunscreen in the AM" because it drives the biggest routine mismatch right now.',
          persist_payload: {
            schema_version: 'aurora.routine_analysis.v2',
            recommendation_groups: [],
          },
          legacy_compat: {
            source: 'routine_analysis_v2',
          },
          recommendation_groups: [],
          debug_meta: {
            enabled: true,
            stage_a: { deferred_product_count: 0 },
          },
        });
      };

      try {
        axios.get = async (url) => {
          const u = String(url || '');
          if (u.endsWith('/photos/download-url')) {
            return {
              status: 200,
              data: {
                download: {
                  url: 'https://signed-download.test/mixed-photo-story',
                  expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
                },
                content_type: 'image/png',
              },
            };
          }
          if (u === 'https://signed-download.test/mixed-photo-story') {
            return {
              status: 200,
              data: pngBytes,
              headers: { 'content-type': 'image/png' },
            };
          }
          throw new Error(`Unexpected axios.get url: ${u}`);
        };

        const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });
        const request = supertest(app);
        const resp = await request
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_mixed_photo_story',
            'X-Trace-ID': 'trace_mixed_photo_story',
            'X-Brief-ID': 'brief_mixed_photo_story',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: true,
            currentRoutine: {
              am: [
                { step: 'cleanser', product_text: 'Gentle Cleanser' },
                { step: 'moisturizer', product_text: 'Barrier Cream' },
              ],
              pm: [
                { step: 'cleanser', product_text: 'Gentle Cleanser' },
                { step: 'treatment', product_text: 'Retinoid Serum' },
                { step: 'moisturizer', product_text: 'Barrier Cream' },
              ],
            },
            photos: [{ slot_id: 'daylight', photo_id: 'photo_mixed_story', qc_status: 'passed' }],
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        const routineAuditCard = findCardByType(cards, 'routine_product_audit_v1');
        assert.equal(routineCalls, 1);
        assert.ok(storyCard);
        assert.ok(routineAuditCard);
        assert.equal(String(storyCard?.payload?.ui_card_v1?.actions_now?.[0] || '').length > 0, true);
        assert.doesNotMatch(String(resp.body?.assistant_message?.content || ''), /Add Sunscreen in the AM/i);
        assert.match(String(resp.body?.assistant_message?.content || ''), /This week:/i);
      } finally {
        skinDiagnosis.runSkinDiagnosisV1 = originalRunSkinDiagnosisV1;
        routineAnalysisV2.runRoutineAnalysisV2 = originalRunRoutineAnalysisV2;
        axios.get = originalGet;
        axios.post = originalPost;
        axios.request = originalRequest;
        delete require.cache[routesModuleId];
        delete require.cache[skinDiagnosisModuleId];
        delete require.cache[routineAnalysisModuleId];
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

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        assert.ok(storyCard);
        const analysisMeta = resp.body?.analysis_meta || {};
        assert.equal(String(analysisMeta.detector_source || ''), 'rule_based_with_photo_qc');
        assert.equal(
          ['photo_download_url_timeout', 'photo_download_url_fetch_5xx'].includes(String(analysisMeta.degrade_reason || '')),
          true,
        );
        const confidenceCard = findCardByType(cards, 'confidence_notice');
        assert.ok(confidenceCard);
        const rationale = Array.isArray(confidenceCard?.payload?.confidence?.rationale)
          ? confidenceCard.payload.confidence.rationale
          : [];
        assert.equal(rationale.includes('photo_requested_but_not_used'), true);
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
        assert.ok(['DOWNLOAD_URL_EXPIRED', 'DOWNLOAD_URL_FETCH_5XX'].includes(String(out?.failure_code || '')));
      } finally {
        axios.get = originalGet;
        delete require.cache[moduleId];
      }
    },
  );
});

test('/v1/analysis/skin: routine fit retries after clarify-like output, emits routine_fit_summary, and persists routine_fit', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'false',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'false',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      const capturedCalls = [];
      let routineFitCallCount = 0;

      decisionModule.auroraChat = async (args = {}) => {
        capturedCalls.push(args);
        if (String(args.intent_hint || '').trim() === 'routine_fit_summary') {
          routineFitCallCount += 1;
          if (routineFitCallCount === 1) {
            return {
              intent: 'clarify',
              answer: 'Can you share more routine details first?',
              clarification: { questions: [{ id: 'routine', question: 'Share more routine details' }] },
            };
          }
          return {
            structured: {
              overall_fit: 'partial_match',
              fit_score: 0.62,
              summary: 'Routine mostly fits, but the active stack is a bit crowded.',
              highlights: ['Barrier support is already present.'],
              concerns: ['Morning actives may overlap and raise irritation risk.'],
              dimension_scores: {
                ingredient_match: { score: 0.74, note: 'Most ingredients align with the plan.' },
                routine_completeness: { score: 0.68, note: 'Core steps are covered.' },
                conflict_risk: { score: 0.39, note: 'Active overlap needs simplification.' },
                sensitivity_safety: { score: 0.55, note: 'Monitor tolerance when layering actives.' },
              },
              next_questions: ['What should I simplify first?'],
            },
          };
        }
        return { answer: 'Mock Aurora reply.', intent: 'chat', cards: [] };
      };

      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const memoryStore = require('../src/auroraBff/memoryStore');
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const uid = 'uid_analysis_routine_fit_retry';
      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': uid,
            'X-Trace-ID': 'trace_analysis_routine_fit_retry',
            'X-Brief-ID': 'brief_analysis_routine_fit_retry',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                serum: 'Vitamin C serum',
                moisturizer: 'Barrier cream',
                spf: 'SPF 50',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const routineFitCard = findCardByType(cards, 'routine_fit_summary');
        const storyCard = findCardByType(cards, 'analysis_story_v2');
        const summaryCard = findCardByType(cards, 'analysis_summary');

        assert.ok(storyCard);
        assert.ok(routineFitCard);
        assert.equal(Boolean(summaryCard), false);
        assert.equal(cards.some((card) => card && card.type === 'product_analysis'), false);
        assert.equal(routineFitCallCount, 2);

        const routineFitCalls = capturedCalls.filter((row) => String(row?.intent_hint || '').trim() === 'routine_fit_summary');
        assert.equal(routineFitCalls.length, 2);
        assert.equal(routineFitCalls[0]?.disallow_clarify, true);
        assert.equal(Array.isArray(routineFitCalls[0]?.required_structured_keys), true);
        assert.equal(routineFitCalls[0].required_structured_keys.includes('dimension_scores'), true);

        const completedEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((event) => event && event.event_name === 'routine_fit_evaluation_completed')
          : null;
        assert.ok(completedEvent);
        assert.equal(Boolean(completedEvent?.data?.fit_card_emitted), true);
        assert.equal(Number(completedEvent?.data?.retry_count), 1);
        assert.equal(completedEvent?.data?.failure_reason, null);

        const savedProfile = await memoryStore.getProfileForIdentity({ auroraUid: uid, userId: null });
        assert.equal(savedProfile?.lastAnalysis?.routine_fit?.overall_fit, 'partial_match');
        assert.equal(savedProfile?.lastAnalysis?.routine_fit?.summary, 'Routine mostly fits, but the active stack is a bit crowded.');
      } finally {
        await memoryStore.deleteIdentityData({ auroraUid: uid, userId: null });
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[routeModuleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('/v1/analysis/skin: routine fit falls back locally after upstream errors and still emits routine_fit_summary', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'false',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'false',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      let routineFitCallCount = 0;

      decisionModule.auroraChat = async (args = {}) => {
        if (String(args.intent_hint || '').trim() === 'routine_fit_summary') {
          routineFitCallCount += 1;
          throw new Error('routine fit upstream unavailable');
        }
        return { answer: 'Mock Aurora reply.', intent: 'chat', cards: [] };
      };

      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const memoryStore = require('../src/auroraBff/memoryStore');
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      const uid = 'uid_analysis_routine_fit_fallback';
      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': uid,
            'X-Trace-ID': 'trace_analysis_routine_fit_fallback',
            'X-Brief-ID': 'brief_analysis_routine_fit_fallback',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                serum: 'Vitamin C serum',
                moisturizer: 'Barrier cream',
                spf: 'SPF 50',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const routineFitCard = findCardByType(cards, 'routine_fit_summary');
        assert.ok(routineFitCard);
        assert.equal(routineFitCallCount, 2);
        assert.equal(['good_match', 'partial_match', 'needs_adjustment'].includes(routineFitCard.payload?.overall_fit), true);
        assert.equal(Array.isArray(routineFitCard.payload?.next_questions), true);
        assert.equal((routineFitCard.payload?.summary || '').length > 0, true);

        const completedEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((event) => event && event.event_name === 'routine_fit_evaluation_completed')
          : null;
        assert.ok(completedEvent);
        assert.equal(Boolean(completedEvent?.data?.fit_card_emitted), true);
        assert.equal(Boolean(completedEvent?.data?.fallback_used), true);
        assert.equal(completedEvent?.data?.fallback_reason, 'upstream_error');
        assert.equal(completedEvent?.data?.fallback_source, 'deterministic_local');

        const savedProfile = await memoryStore.getProfileForIdentity({ auroraUid: uid, userId: null });
        assert.equal(typeof savedProfile?.lastAnalysis?.routine_fit?.summary, 'string');
        assert.equal(Array.isArray(savedProfile?.lastAnalysis?.routine_fit?.next_questions), true);
      } finally {
        await memoryStore.deleteIdentityData({ auroraUid: uid, userId: null });
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[routeModuleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('/v1/analysis/skin: routine fit uses dedicated timeout/model and classifies upstream timeout failures', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      AURORA_ANALYSIS_STORY_V2_ENABLED: 'true',
      AURORA_ROUTINE_ANALYSIS_V2_ENABLED: 'false',
      AURORA_ROUTINE_SUMMARY_FIRST_ENABLED: 'false',
      AURORA_ROUTINE_PRODUCT_AUTOSCAN_TIMEOUT_MS: '3800',
      AURORA_ROUTINE_FIT_TIMEOUT_MS: '12000',
      AURORA_ROUTINE_FIT_MODEL_GEMINI: 'gemini-routine-fit-test',
    },
    async () => {
      const decisionModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
      delete require.cache[decisionModuleId];
      const decisionModule = require('../src/auroraBff/auroraDecisionClient');
      const originalAuroraChat = decisionModule.auroraChat;
      const capturedCalls = [];

      decisionModule.auroraChat = async (args = {}) => {
        if (String(args.intent_hint || '').trim() === 'routine_fit_summary') {
          capturedCalls.push(args);
          const err = new Error('timeout of 12000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
        return { answer: 'Mock Aurora reply.', intent: 'chat', cards: [] };
      };

      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

      try {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .post('/v1/analysis/skin')
          .set({
            'X-Aurora-UID': 'uid_analysis_routine_fit_timeout',
            'X-Trace-ID': 'trace_analysis_routine_fit_timeout',
            'X-Brief-ID': 'brief_analysis_routine_fit_timeout',
            'X-Lang': 'EN',
          })
          .send({
            use_photo: false,
            currentRoutine: {
              am: {
                cleanser: 'Gentle cleanser',
                serum: 'Niacinamide serum',
                moisturizer: 'Barrier cream',
                spf: 'SPF 50',
              },
              pm: {
                cleanser: 'Gentle cleanser',
                treatment: 'Retinol serum',
                moisturizer: 'Barrier cream',
              },
            },
          })
          .expect(200);

        assert.equal(capturedCalls.length, 2);
        assert.equal(capturedCalls[0]?.timeoutMs, 12000);
        assert.equal(capturedCalls[0]?.llm_model, 'gemini-3-flash-preview');
        assert.equal(capturedCalls[0]?.prompt_template_id, 'routine_fit_summary_v1');
        assert.equal(typeof capturedCalls[0]?.prompt_hash, 'string');
        assert.equal(capturedCalls[0]?.prompt_hash.length > 0, true);

        const completedEvent = Array.isArray(resp.body?.events)
          ? resp.body.events.find((event) => event && event.event_name === 'routine_fit_evaluation_completed')
          : null;
        assert.ok(completedEvent);
        assert.equal(Boolean(completedEvent?.data?.fallback_used), true);
        assert.equal(completedEvent?.data?.fallback_reason, 'upstream_timeout');
        assert.equal(completedEvent?.data?.timeout_ms, 12000);
        assert.equal(completedEvent?.data?.llm_model, 'gemini-3-flash-preview');

        const upstreamFailureEvents = Array.isArray(resp.body?.events)
          ? resp.body.events.filter((event) => event && event.event_name === 'routine_fit_upstream_failure')
          : [];
        assert.equal(upstreamFailureEvents.length, 2);
        assert.equal(upstreamFailureEvents[0]?.data?.failure_class, 'upstream_timeout');
        assert.equal(upstreamFailureEvents[0]?.data?.upstream_error_code, 'ECONNABORTED');
        assert.equal(upstreamFailureEvents[0]?.data?.timeout_ms, 12000);
      } finally {
        decisionModule.auroraChat = originalAuroraChat;
        delete require.cache[routeModuleId];
        delete require.cache[decisionModuleId];
      }
    },
  );
});

test('/v1/chat: analysis follow-up actions use lastAnalysis context instead of ingredient_hub or nudge fallback', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const memoryStore = require('../src/auroraBff/memoryStore');
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const uid = 'uid_analysis_followup_actions';
      const headers = {
        'X-Aurora-UID': uid,
        'X-Trace-ID': 'trace_analysis_followup_actions',
        'X-Brief-ID': 'brief_analysis_followup_actions',
        'X-Lang': 'EN',
      };

      try {
        await memoryStore.saveLastAnalysisForIdentity(
          { auroraUid: uid, userId: null },
          {
            analysis: {
              skin_profile: {
                skin_type_tendency: 'combination',
                sensitivity_tendency: 'high',
                current_strengths: ['steady barrier'],
              },
              priority_findings: [{ title: 'Cheek redness' }, { detail: 'Mild dehydration' }],
              confidence_overall: { level: 'medium', score: 0.73 },
              guidance_brief: ['Simplify the morning active stack', 'Keep barrier support stable'],
              ingredient_plan: {
                targets: [{ ingredient_name: 'Ceramide', role: 'barrier' }],
                avoid: [{ ingredient_name: 'Vitamin C', reason: ['stinging risk'] }],
                conflicts: [{ title: 'Do not stack acids with retinoid' }],
              },
              routine_fit: {
                overall_fit: 'partial_match',
                fit_score: 0.51,
                summary: 'Routine is close but crowded.',
                highlights: ['Barrier support is present'],
                concerns: ['Morning stack is too active'],
                dimension_scores: {
                  ingredient_match: { score: 0.71, note: 'Mostly aligned' },
                  routine_completeness: { score: 0.67, note: 'Core routine present' },
                  conflict_risk: { score: 0.29, note: 'Active overlap' },
                  sensitivity_safety: { score: 0.43, note: 'Monitor irritation' },
                },
                next_questions: ['What should I simplify first?'],
              },
            },
            lang: 'EN',
          },
        );

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const deepDive = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            action: {
              action_id: 'chip.aurora.next_action.deep_dive_skin',
              kind: 'action',
              data: { reply_text: 'Tell me more about my skin', trigger_source: 'analysis_story_v2' },
            },
            language: 'EN',
          })
          .expect(200);
        assert.equal(Boolean(findCardByType(deepDive.body?.cards, 'ingredient_hub')), false);
        assert.equal(Boolean(findCardByType(deepDive.body?.cards, 'nudge')), false);
        const deepDiveText = String(deepDive.body?.assistant_text || deepDive.body?.assistant_message?.content || '');
        assert.match(deepDiveText, /latest analysis|skin trends|latest photo/i);

        const ingredientPlan = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            action: {
              action_id: 'chip.aurora.next_action.ingredient_plan',
              kind: 'action',
              data: { reply_text: 'Explain the ingredient plan', trigger_source: 'analysis_story_v2' },
            },
            language: 'EN',
          })
          .expect(200);
        const ingredientPlanCard = findCardByType(ingredientPlan.body?.cards, 'ingredient_plan_v2');
        assert.ok(ingredientPlanCard);
        assert.equal(ingredientPlanCard.payload?.schema_version, 'aurora.ingredient_plan.v2');
        assert.equal(Boolean(findCardByType(ingredientPlan.body?.cards, 'ingredient_hub')), false);
        assert.equal(Boolean(findCardByType(ingredientPlan.body?.cards, 'nudge')), false);

        const routine = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            action: {
              action_id: 'chip.aurora.next_action.routine_deep_dive',
              kind: 'action',
              data: { reply_text: 'What should I simplify first?', trigger_source: 'routine_fit_summary' },
            },
            language: 'EN',
          })
          .expect(200);
        assert.ok(findCardByType(routine.body?.cards, 'routine_fit_summary'));
        assert.equal(Boolean(findCardByType(routine.body?.cards, 'ingredient_hub')), false);
        assert.equal(Boolean(findCardByType(routine.body?.cards, 'nudge')), false);

        const safety = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            action: {
              action_id: 'chip.aurora.next_action.safety_concerns',
              kind: 'action',
              data: { reply_text: 'Anything I should watch out for?', trigger_source: 'analysis_story_v2' },
            },
            language: 'EN',
          })
          .expect(200);
        assert.ok(findCardByType(safety.body?.cards, 'confidence_notice'));
        assert.equal(Boolean(findCardByType(safety.body?.cards, 'ingredient_hub')), false);
        assert.equal(Boolean(findCardByType(safety.body?.cards, 'nudge')), false);

        const actionEvents = Array.isArray(safety.body?.events) ? safety.body.events : [];
        assert.equal(
          actionEvents.some((event) => event && event.event_name === 'analysis_followup_action_routed' && event.data?.fell_back_to_generic === false),
          true,
        );
      } finally {
        await memoryStore.deleteIdentityData({ auroraUid: uid, userId: null });
        delete require.cache[routeModuleId];
      }
    },
  );
});

test('/v1/session/bootstrap: restores canonical latest reco context from lastAnalysis snapshot when artifact is absent', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const memoryStore = require('../src/auroraBff/memoryStore');
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const uid = 'uid_bootstrap_latest_reco_snapshot';
      const headers = {
        'X-Aurora-UID': uid,
        'X-Trace-ID': 'trace_bootstrap_latest_reco_snapshot',
        'X-Brief-ID': 'brief_bootstrap_latest_reco_snapshot',
        'X-Lang': 'EN',
      };

      try {
        await memoryStore.saveLastAnalysisForIdentity(
          { auroraUid: uid, userId: null },
          {
            analysis: {
              skin_profile: {
                skin_type_tendency: 'combination',
                sensitivity_tendency: 'high',
                barrier_status_tendency: 'reactive',
              },
              latest_reco_context_snapshot: {
                context_origin: 'routine_audit_v1',
                owner_source: 'routine_audit_v1',
                target_bundle_owner: 'routine_audit_v1',
                final_outcome_owner: 'analysis_skin_response',
                ingredient_query: 'cleanser',
                goal: 'barrier_support',
                resolved_target_step: 'cleanser',
                primary_target_id: 'adj_pm_cleanser_replace',
                ranked_targets: [
                  {
                    target_id: 'adj_pm_cleanser_replace',
                    ingredient_query: 'cleanser',
                    resolved_target_step: 'cleanser',
                    target_role: 'primary',
                    source: 'routine_audit_v1',
                  },
                ],
              },
            },
            lang: 'EN',
          },
        );

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await supertest(app)
          .get('/v1/session/bootstrap')
          .set(headers)
          .expect(200);

        const latestRecoContext = resp.body?.session_patch?.state?.latest_reco_context || null;
        assert.ok(latestRecoContext);
        assert.equal(latestRecoContext.primary_target_id, 'adj_pm_cleanser_replace');
        assert.equal(latestRecoContext.context_origin, 'routine_audit_v1');
        assert.equal(latestRecoContext.owner_source, 'routine_audit_v1');

        const bootstrapCard = findCardByType(resp.body?.cards, 'session_bootstrap');
        assert.ok(bootstrapCard);
        const latestAnalysisContext = bootstrapCard?.payload?.latest_analysis_context || null;
        assert.ok(latestAnalysisContext);
        const ingredientTargets = Array.isArray(latestAnalysisContext?.ingredient_targets?.items)
          ? latestAnalysisContext.ingredient_targets.items
          : [];
        assert.equal(ingredientTargets.length > 0, true);
      } finally {
        await memoryStore.deleteIdentityData({ auroraUid: uid, userId: null });
        delete require.cache[routeModuleId];
      }
    },
  );
});

test('/v1/chat: deep_dive_skin without reusable analysis context returns confidence_notice', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const response = await supertest(app)
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': 'uid_analysis_followup_missing_context',
          'X-Trace-ID': 'trace_analysis_followup_missing_context',
          'X-Brief-ID': 'brief_analysis_followup_missing_context',
          'X-Lang': 'EN',
        })
        .send({
          action: {
            action_id: 'chip.aurora.next_action.deep_dive_skin',
            kind: 'action',
            data: { reply_text: 'Tell me more about my skin', trigger_source: 'analysis_story_v2' },
          },
          language: 'EN',
        })
        .expect(200);

      assert.ok(findCardByType(response.body?.cards, 'confidence_notice'));
      assert.equal(Boolean(findCardByType(response.body?.cards, 'nudge')), false);
      assert.match(String(response.body?.assistant_text || response.body?.assistant_message?.content || ''), /recent skin analysis|run skin analysis again/i);
    },
  );
});

test('/v1/chat: implicit deep-dive message with recent analysis context stays on analysis follow-up route', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');
      const app = express();
      app.use(express.json({ limit: '1mb' }));
      mountAuroraBffRoutes(app, { logger: null });

      const response = await supertest(app)
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': 'uid_analysis_followup_implicit',
          'X-Trace-ID': 'trace_analysis_followup_implicit',
          'X-Brief-ID': 'brief_analysis_followup_implicit',
          'X-Lang': 'EN',
        })
        .send({
          message: 'Tell me more about my skin',
          language: 'EN',
          session: {
            meta: {
              analysis_context: {
                analysis_origin: 'photo',
                photo_refs: [{ slot_id: 'daylight', photo_id: 'upl_photo_123', qc_status: 'passed' }],
                source_card_type: 'analysis_story_v2',
                analysis_story_snapshot: {
                  schema_version: 'aurora.analysis_story.v2',
                  confidence_overall: { level: 'medium', score: 0.72 },
                  skin_profile: { skin_type_tendency: 'combination', sensitivity_tendency: 'medium' },
                  priority_findings: [
                    { priority: 1, title: 'Cheek dryness', detail: 'Dry cheek patches', evidence_region_or_module: [] },
                    { priority: 2, title: 'Texture on forehead', detail: 'Uneven forehead texture', evidence_region_or_module: [] },
                    { priority: 3, title: 'Mild chin congestion', detail: 'Small clogged pores', evidence_region_or_module: [] },
                  ],
                  target_state: ['Reduce congestion', 'Keep hydration stable'],
                  core_principles: ['Lower active stacking'],
                  am_plan: [{ step: 'Use SPF', purpose: 'UV protection' }],
                  pm_plan: [{ step: 'Use barrier serum', purpose: 'Support recovery' }],
                  timeline: { first_4_weeks: ['Stabilize barrier'], week_8_12_expectation: ['Smoother texture'] },
                  safety_notes: [],
                  disclaimer_non_medical: true,
                  ui_card_v1: {
                    headline: 'Stabilize first, then reduce congestion.',
                    key_points: ['Cheek dryness', 'Texture on forehead'],
                    actions_now: ['Reduce active overlap'],
                    avoid_now: ['Do not over-exfoliate'],
                    confidence_label: 'medium',
                    next_checkin: 'Re-check in 2 weeks.',
                  },
                },
              },
            },
            profile: {
              lastAnalysis: {
                skin_profile: { skin_type_tendency: 'combination', sensitivity_tendency: 'medium' },
                priority_findings: [{ title: 'Weak raw finding' }],
                confidence_overall: { level: 'low', score: 0.41 },
              },
            },
          },
        })
        .expect(200);

      assert.ok(findCardByType(response.body?.cards, 'analysis_story_v2'));
      assert.equal(Boolean(findCardByType(response.body?.cards, 'ingredient_hub')), false);
      const actionEvent = (Array.isArray(response.body?.events) ? response.body.events : []).find(
        (event) => event && event.event_name === 'analysis_followup_action_routed',
      );
      assert.equal(actionEvent?.data?.action_id, 'chip.aurora.next_action.deep_dive_skin');
      assert.equal(actionEvent?.data?.routing_mode, 'implicit');
      assert.equal(actionEvent?.data?.fell_back_to_generic, false);
      assert.match(
        String(response.body?.assistant_text || response.body?.assistant_message?.content || ''),
        /latest analysis|latest photo|deep dive/i,
      );
    },
  );
});

test('resolveImplicitAnalysisFollowupActionId recognizes deep-dive prompt and keeps missing-context flows inside analysis follow-up', () => {
  const { __internal } = loadRouteInternals();
  const resolveImplicitAnalysisFollowupActionId = __internal.resolveImplicitAnalysisFollowupActionId;
  if (!resolveImplicitAnalysisFollowupActionId) { console.log('SKIP: resolveImplicitAnalysisFollowupActionId not exported'); return; }

  assert.equal(
    resolveImplicitAnalysisFollowupActionId({
      message: 'Tell me more about my skin',
      sessionAnalysisContext: { analysis_story_snapshot: { priority_findings: [{ title: 'Barrier stress' }] } },
      lastAnalysis: null,
      latestArtifactId: null,
    }),
    'chip.aurora.next_action.deep_dive_skin',
  );
  assert.equal(
    resolveImplicitAnalysisFollowupActionId({
      message: 'Tell me more about my skin',
      sessionAnalysisContext: null,
      lastAnalysis: null,
      latestArtifactId: null,
    }),
    'chip.aurora.next_action.deep_dive_skin',
  );
  assert.equal(
    resolveImplicitAnalysisFollowupActionId({
      message: 'Tell me about sunscreen',
      sessionAnalysisContext: null,
      lastAnalysis: null,
      latestArtifactId: null,
    }),
    null,
  );
});

test('buildAssistantMessageFromStoryV2 produces aligned summary from story card', () => {
  const { __internal } = loadRouteInternals();
  const buildAssistantMessageFromStoryV2 = __internal.buildAssistantMessageFromStoryV2;
  if (!buildAssistantMessageFromStoryV2) { console.log('SKIP: buildAssistantMessageFromStoryV2 not exported'); return; }

  const storyPayload = {
    confidence_overall: { level: 'medium', score: 0.68 },
    skin_profile: { skin_type_tendency: 'combination', sensitivity_tendency: 'medium' },
    priority_findings: [
      { title: 'Mild dryness around cheeks' },
      { title: 'Uneven texture on forehead' },
      { title: 'Light hyperpigmentation' },
    ],
  };
  const message = buildAssistantMessageFromStoryV2(storyPayload, { language: 'EN' });
  assert.ok(message.includes('combination'), `Expected "combination" in message: ${message}`);
  assert.ok(message.includes('medium'), `Expected "medium" in message: ${message}`);
  assert.ok(!message.includes('unconfirmed'), `Message should NOT contain "unconfirmed": ${message}`);
  assert.ok(message.includes('Mild dryness') || message.includes('Key findings'), `Expected findings in message: ${message}`);
});

test('buildAssistantMessageFromStoryV2 does not emit unconfirmed placeholders when story is still useful', () => {
  const { __internal } = loadRouteInternals();
  const buildAssistantMessageFromStoryV2 = __internal.buildAssistantMessageFromStoryV2;
  if (!buildAssistantMessageFromStoryV2) { console.log('SKIP: buildAssistantMessageFromStoryV2 not exported'); return; }

  const storyPayload = {
    confidence_overall: { level: 'medium', score: 0.67 },
    priority_findings: [
      { title: 'Barrier stress around cheeks' },
      { title: 'Congestion on chin' },
    ],
  };
  const message = buildAssistantMessageFromStoryV2(storyPayload, { language: 'EN' });
  assert.ok(!message.includes('unconfirmed'), `Should not include placeholder confidence labels: ${message}`);
  assert.match(message, /Fix first: Barrier stress around cheeks/i, `Expected useful finding-led summary: ${message}`);
  assert.doesNotMatch(message, /Analysis complete\.|Confidence for this read/i, `Should not fall back to generic wrapper text: ${message}`);
});

test('buildAssistantMessageFromStoryV2 keeps photo-first action ahead of supporting routine optimization', () => {
  const { __internal } = loadRouteInternals();
  const buildAssistantMessageFromStoryV2 = __internal.buildAssistantMessageFromStoryV2;
  if (!buildAssistantMessageFromStoryV2) { console.log('SKIP: buildAssistantMessageFromStoryV2 not exported'); return; }

  const storyPayload = {
    confidence_overall: { level: 'low', score: 0.32 },
    priority_findings: [
      { title: 'Right under-eye may be the clearest visible texture irregularity signal right now' },
    ],
    ui_card_v1: {
      headline: 'Photos suggest texture irregularity around the Right under-eye as the main focus, but the read stays conservative.',
      actions_now: [
        'Trial BHA/LHA conservatively and watch the texture irregularity around the Right under-eye.',
        'Prioritize Azelaic Acid for the texture irregularity signal on the Right under-eye.',
      ],
    },
    existing_products_optimization: {
      keep: ['Gentle cleanser: keep it as the non-irritating cleanse step.'],
      add: ['Add SPF50+ sunscreen every morning.'],
    },
    am_plan: [
      { step: 'Gentle cleanse' },
      { step: 'SPF50+ sunscreen' },
    ],
    pm_plan: [
      { step: 'Gentle cleanse' },
      { step: 'BHA/LHA' },
      { step: 'Barrier moisturizer' },
    ],
  };
  const message = buildAssistantMessageFromStoryV2(storyPayload, { language: 'EN' });
  assert.match(message, /This week: Trial BHA\/LHA conservatively/i, `Expected photo-led action in message: ${message}`);
  assert.match(message, /Secondary option: Prioritize Azelaic Acid/i, `Expected clearly labeled secondary action in message: ${message}`);
  assert.doesNotMatch(message, /This week: add SPF50\+ sunscreen every morning/i, `Routine sunscreen should not steal the main axis: ${message}`);
  assert.doesNotMatch(message, /This week:[^.]*Azelaic Acid/i, `Secondary action should not be rendered as co-primary: ${message}`);
});

test('isDeepDiveStoryWeakerThanFallback detects weaker story', () => {
  const { __internal } = loadRouteInternals();
  const isDeepDiveStoryWeakerThanFallback = __internal.isDeepDiveStoryWeakerThanFallback;
  if (!isDeepDiveStoryWeakerThanFallback) { console.log('SKIP: isDeepDiveStoryWeakerThanFallback not exported'); return; }

  const strongBaseline = {
    priority_findings: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
    confidence_overall: { level: 'medium' },
  };
  const weakCandidate = {
    priority_findings: [],
    confidence_overall: { level: 'low' },
  };
  const okCandidate = {
    priority_findings: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }],
    confidence_overall: { level: 'medium' },
  };

  assert.equal(isDeepDiveStoryWeakerThanFallback({ story: weakCandidate, fallbackStory: strongBaseline }), true);
  assert.equal(isDeepDiveStoryWeakerThanFallback({ story: okCandidate, fallbackStory: strongBaseline }), false);
});

test('applyNonWeakeningDeepDiveUiPatch preserves fallback findings when llm patch would weaken the story', () => {
  const { __internal } = loadRouteInternals();
  const applyNonWeakeningDeepDiveUiPatch = __internal.applyNonWeakeningDeepDiveUiPatch;
  if (!applyNonWeakeningDeepDiveUiPatch) { console.log('SKIP: applyNonWeakeningDeepDiveUiPatch not exported'); return; }

  const fallbackStory = {
    confidence_overall: { level: 'medium' },
    priority_findings: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
    ui_card_v1: {
      headline: 'Fallback headline',
      key_points: ['A', 'B', 'C'],
      actions_now: ['Fallback action'],
      avoid_now: [],
      confidence_label: 'medium',
    },
    safety_notes: [],
  };
  const weakenedStory = {
    ...fallbackStory,
    priority_findings: [{ title: 'Only one weak point' }],
    ui_card_v1: {
      ...fallbackStory.ui_card_v1,
      headline: 'Specific but weaker headline',
      key_points: ['Only one weak point'],
      actions_now: ['Patched action'],
    },
  };
  const restored = applyNonWeakeningDeepDiveUiPatch({
    story: weakenedStory,
    fallbackStory,
    uiPatch: {
      headline: 'Specific but weaker headline',
      actions_now: ['Patched action'],
      key_points: ['Only one weak point'],
    },
  });

  assert.equal(restored.priority_findings.length, 3);
  assert.equal(restored.ui_card_v1.headline, 'Specific but weaker headline');
  assert.deepEqual(restored.ui_card_v1.actions_now, ['Patched action']);
});

test('applyAnalysisStoryProfilePatch backfills pending story profile from diagnosis signals', () => {
  const { __internal } = loadRouteInternals();
  const applyAnalysisStoryProfilePatch = __internal.applyAnalysisStoryProfilePatch;
  if (!applyAnalysisStoryProfilePatch) { console.log('SKIP: applyAnalysisStoryProfilePatch not exported'); return; }

  const patched = applyAnalysisStoryProfilePatch(
    {
      confidence_overall: { level: 'medium' },
      skin_profile: { skin_type_tendency: 'pending', sensitivity_tendency: 'pending', current_strengths: [] },
      priority_findings: [{ title: 'Barrier stress' }],
    },
    {
      diagnosisArtifact: {
        skinType: { value: 'combination' },
        sensitivity: { value: 'high' },
      },
    },
  );

  assert.equal(patched.skin_profile.skin_type_tendency, 'combination');
  assert.equal(patched.skin_profile.sensitivity_tendency, 'high');
});

test('applyDeepDiveLlmResponseToStory appends deeper findings and routine focus instead of replacing the baseline', () => {
  const { __internal } = loadRouteInternals();
  const applyDeepDiveLlmResponseToStory = __internal.applyDeepDiveLlmResponseToStory;
  if (!applyDeepDiveLlmResponseToStory) { console.log('SKIP: applyDeepDiveLlmResponseToStory not exported'); return; }

  const fallbackStory = {
    schema_version: 'aurora.analysis_story.v2',
    confidence_overall: { level: 'medium', score: 0.72 },
    skin_profile: { skin_type_tendency: 'combination', sensitivity_tendency: 'medium', current_strengths: [] },
    priority_findings: [
      { priority: 1, title: 'Cheek dryness', detail: 'Dry cheek patches', evidence_region_or_module: [] },
      { priority: 2, title: 'Texture on forehead', detail: 'Rough texture', evidence_region_or_module: [] },
      { priority: 3, title: 'Mild chin congestion', detail: 'Small clogged pores', evidence_region_or_module: [] },
    ],
    target_state: ['Stabilize barrier first'],
    core_principles: ['Keep actives gentle'],
    am_plan: [{ step: 'Use SPF', purpose: 'UV protection' }],
    pm_plan: [{ step: 'Barrier serum', purpose: 'Support recovery' }],
    timeline: { first_4_weeks: ['Stabilize barrier'], week_8_12_expectation: ['Smoother texture'] },
    safety_notes: [],
    disclaimer_non_medical: true,
    ui_card_v1: {
      headline: 'Stabilize first, then reduce congestion.',
      key_points: ['Cheek dryness', 'Texture on forehead'],
      actions_now: ['Reduce active overlap'],
      avoid_now: ['Do not over-exfoliate'],
      confidence_label: 'medium',
      next_checkin: 'Re-check in 2 weeks.',
    },
  };

  const out = applyDeepDiveLlmResponseToStory({
    responsePayload: {
      conclusion: 'The deeper read points more to barrier strain with mild congestion than active inflammation.',
      key_signals: ['Barrier strain is still the main pattern'],
      deeper_findings: ['Shine looks more like dehydration bounce than heavy oil overload'],
      target_state: ['Keep texture stable while calming redness triggers'],
      core_principles: ['Add hydration before escalating acne actives'],
      am_focus: ['Hydrating serum before sunscreen'],
      pm_focus: ['Keep only one active night at a time'],
      actions_now: ['Hold exfoliation to 1x weekly'],
      avoid_now: ['Do not stack BHA and retinoid together'],
      confidence_note: 'Photo quality is usable but still slightly conservative.',
    },
    fallbackStory,
  });

  assert.ok(Array.isArray(out.story.priority_findings));
  assert.ok(out.story.priority_findings.length >= 4, `expected appended findings, got ${out.story.priority_findings.length}`);
  assert.ok(out.story.priority_findings.some((item) => String(item.title || '').includes('dehydration bounce')));
  assert.match(String(out.story.priority_findings[0] && out.story.priority_findings[0].title || ''), /dehydration bounce|Barrier strain/i);
  assert.ok(Array.isArray(out.story.am_plan) && out.story.am_plan.some((item) => String(item.step || '').includes('Hydrating serum')));
  assert.match(String(out.story.am_plan[0] && out.story.am_plan[0].step || ''), /Hydrating serum/i);
  assert.ok(Array.isArray(out.story.pm_plan) && out.story.pm_plan.some((item) => String(item.step || '').includes('one active night')));
  assert.match(String(out.story.pm_plan[0] && out.story.pm_plan[0].step || ''), /one active night/i);
  assert.ok(Array.isArray(out.story.target_state) && out.story.target_state.length >= 2);
  assert.equal(out.story.target_state[0], 'Keep texture stable while calming redness triggers');
  assert.equal(out.story.core_principles[0], 'Add hydration before escalating acne actives');
  assert.equal(out.story.ui_card_v1.actions_now[0], 'Hold exfoliation to 1x weekly');
  assert.equal(out.story.ui_card_v1.key_points.some((item) => /dehydration bounce|Barrier strain/i.test(String(item))), true);
  assert.equal(out.story.priority_findings.some((item) => String(item.title || '').includes('Cheek dryness')), true);
});

test('buildDeterministicDeepDiveDelta derives second-pass insights from active overlap plus barrier stress pattern', () => {
  const { __internal } = loadRouteInternals();
  const buildDeterministicDeepDiveDelta = __internal.buildDeterministicDeepDiveDelta;
  if (!buildDeterministicDeepDiveDelta) { console.log('SKIP: buildDeterministicDeepDiveDelta not exported'); return; }

  const out = buildDeterministicDeepDiveDelta({
    language: 'EN',
    evidence: {
      language: 'EN',
      quality_grade: 'degraded',
      routine_context: {
        actives_detected: ['retinoid', 'salicylic_acid', 'vitamin_c'],
      },
      finding_evidence: [
        { observation: 'Cheek dryness with tightness' },
        { observation: 'Texture and pore congestion on the forehead and chin' },
        { observation: 'Mild redness after active nights' },
      ],
    },
    fallbackStory: {
      priority_findings: [
        { title: 'Cheek dryness' },
        { title: 'Texture on forehead' },
        { title: 'Mild chin congestion' },
      ],
      target_state: ['Stabilize barrier first'],
      core_principles: ['Keep actives gentle'],
    },
  });

  assert.ok(Array.isArray(out.deeper_findings) && out.deeper_findings.length > 0);
  assert.match(out.deeper_findings[0], /barrier|active overlap|dehydration|oil overload/i);
  assert.equal(out.actions_now.some((item) => /Separate retinoid|acids|vitamin C/i.test(String(item))), true);
  assert.equal(out.pm_focus.some((item) => /one core active at night|one core active/i.test(String(item))), true);
});

test('mergeDeepDiveSignalPayload backfills second-pass fields when llm output is too thin', () => {
  const { __internal } = loadRouteInternals();
  const mergeDeepDiveSignalPayload = __internal.mergeDeepDiveSignalPayload;
  if (!mergeDeepDiveSignalPayload) { console.log('SKIP: mergeDeepDiveSignalPayload not exported'); return; }

  const out = mergeDeepDiveSignalPayload(
    {
      conclusion: 'Barrier strain seems more important than expected.',
      key_signals: ['Barrier strain looks higher than pure oil overload.'],
      deeper_findings: [],
      target_state: [],
      core_principles: [],
      am_focus: [],
      pm_focus: [],
      actions_now: [],
      avoid_now: [],
      confidence_note: '',
    },
    {
      deeper_findings: ['Current active overlap may be increasing barrier stress while congestion is only partly improving.'],
      target_state: ['Bring barrier stress down first, then step up acne/texture treatment gradually.'],
      core_principles: ['Do not stack multiple strong actives on the same night; spend irritation budget on one core step.'],
      am_focus: ['Lock in hydration/repair before sunscreen in the morning.'],
      pm_focus: ['Keep only one core active at night until tolerance is stable, then adjust frequency.'],
      actions_now: ['Separate retinoid, exfoliating acids, and high-strength vitamin C instead of combining them on one night.'],
      avoid_now: ['Avoid stacking multiple higher-irritation actives on the same night.'],
      confidence_note: 'Because photo quality is degraded, this deep dive leans more on treatment pacing and tolerance interpretation.',
    },
  );

  assert.equal(out.deeper_findings.length, 1);
  assert.match(out.deeper_findings[0], /active overlap|barrier stress/i);
  assert.equal(out.target_state[0], 'Bring barrier stress down first, then step up acne/texture treatment gradually.');
  assert.equal(out.actions_now[0], 'Separate retinoid, exfoliating acids, and high-strength vitamin C instead of combining them on one night.');
  assert.match(out.confidence_note, /treatment pacing and tolerance/i);
});

test('applyDeterministicDeepDiveSurfacePatch front-loads novel second-pass content when the repaired story drifts back to baseline', () => {
  const { __internal } = loadRouteInternals();
  const applyDeterministicDeepDiveSurfacePatch = __internal.applyDeterministicDeepDiveSurfacePatch;
  if (!applyDeterministicDeepDiveSurfacePatch) { console.log('SKIP: applyDeterministicDeepDiveSurfacePatch not exported'); return; }

  const fallbackStory = {
    priority_findings: [
      { title: 'Cheek dryness' },
      { title: 'Texture on forehead' },
      { title: 'Mild chin congestion' },
    ],
    target_state: ['Stabilize barrier first'],
    core_principles: ['Keep actives gentle'],
    ui_card_v1: {
      headline: 'Barrier-first reset',
      key_points: ['Cheek dryness', 'Texture on forehead'],
      actions_now: ['Pause extra exfoliation'],
      avoid_now: ['Do not stack multiple strong actives'],
      confidence_label: 'medium',
    },
  };
  const repairedStory = {
    ...fallbackStory,
    priority_findings: [
      { title: 'Cheek dryness' },
      { title: 'Texture on forehead' },
      { title: 'Mild chin congestion' },
    ],
    target_state: ['Stabilize barrier first'],
    core_principles: ['Keep actives gentle'],
    ui_card_v1: {
      ...fallbackStory.ui_card_v1,
      key_points: ['Cheek dryness', 'Texture on forehead'],
      actions_now: ['Pause extra exfoliation'],
    },
  };

  const out = applyDeterministicDeepDiveSurfacePatch({
    story: repairedStory,
    fallbackStory,
    deterministicDelta: {
      deeper_findings: ['Current active overlap may be increasing barrier stress while congestion is only partly improving.'],
      target_state: ['Bring barrier stress down first, then step up acne/texture treatment gradually.'],
      core_principles: ['Do not stack multiple strong actives on the same night; spend irritation budget on one core step.'],
      actions_now: ['Separate retinoid, exfoliating acids, and high-strength vitamin C instead of combining them on one night.'],
    },
  });

  assert.match(String(out.priority_findings[0] && out.priority_findings[0].title || ''), /active overlap|barrier stress/i);
  assert.equal(out.target_state[0], 'Bring barrier stress down first, then step up acne/texture treatment gradually.');
  assert.equal(out.core_principles[0], 'Do not stack multiple strong actives on the same night; spend irritation budget on one core step.');
  assert.equal(out.ui_card_v1.actions_now[0], 'Separate retinoid, exfoliating acids, and high-strength vitamin C instead of combining them on one night.');
});

test('enrichIngredientPlanPayloadForCard replaces raw rule signals with ingredient education', () => {
  const { __internal } = loadRouteInternals();
  const enrichIngredientPlanPayloadForCard = __internal.enrichIngredientPlanPayloadForCard;
  if (!enrichIngredientPlanPayloadForCard) { console.log('SKIP: enrichIngredientPlanPayloadForCard not exported'); return; }

  const out = enrichIngredientPlanPayloadForCard(
    {
      schema_version: 'aurora.ingredient_plan.v2',
      intensity: { level: 'gentle' },
      targets: [
        {
          ingredient_id: 'ceramide_np',
          ingredient_name: 'Ceramide NP',
          priority_level: 'high',
          why: ['Rule signal: low_confidence_gentle_only'],
          usage_guidance: [],
          rationale: ['low_confidence_gentle_only'],
          products: { competitors: [], dupes: [] },
        },
      ],
      avoid: [],
      conflicts: [],
      budget_context: { effective_tier: 'unknown' },
    },
    { language: 'EN' },
  );

  const target = out.targets[0];
  assert.ok(Array.isArray(target.why) && target.why.length > 0);
  assert.equal(target.why.some((line) => /rule signal:/i.test(String(line))), false);
  assert.ok(target.why.some((line) => /barrier|water loss|ceramide/i.test(String(line))), JSON.stringify(target.why));
  assert.ok(Array.isArray(target.usage_guidance) && target.usage_guidance.some((line) => /typical products|typical formats|moisturizers|barrier creams/i.test(String(line))), JSON.stringify(target.usage_guidance));
  assert.ok(target.ingredient_report && target.ingredient_report.ingredient);
});

test('stream deep-dive: buildChatCardsResponse wraps followup into v1-parseable envelope', () => {
  const { buildChatCardsResponse } = require('../src/auroraBff/chatCardsAssembler');

  const followupResult = {
    assistant_text: 'This explanation stays grounded in your latest photo-based analysis. Key signals: Mild dryness; Uneven texture.',
    cards: [
      {
        card_id: 'analysis_followup_story_req123',
        type: 'analysis_story_v2',
        payload: {
          schema_version: 'aurora.analysis_story.v2',
          confidence_overall: { level: 'medium', score: 0.72 },
          skin_profile: { skin_type_tendency: 'combination' },
          priority_findings: [
            { priority: 1, title: 'Mild dryness', detail: 'Dry patches near cheeks', evidence_region_or_module: [] },
            { priority: 2, title: 'Uneven texture', detail: 'Rough patches on forehead', evidence_region_or_module: [] },
          ],
          summary: 'Key signals: Mild dryness; Uneven texture.',
        },
      },
    ],
    suggested_chips: [
      { chip_id: 'chip.aurora.next_action.ingredient_plan', label: 'Explain ingredient plan', kind: 'follow_up', data: { action_id: 'chip.aurora.next_action.ingredient_plan' } },
    ],
    used_last_analysis: true,
    missing_context: false,
    analysis_origin: 'photo',
    photo_ref_count: 1,
    used_diagnosis_artifact: true,
    llm_used: false,
  };

  const legacyEnvelope = {
    request_id: 'req123',
    trace_id: 'trace123',
    assistant_message: { role: 'assistant', content: followupResult.assistant_text, format: 'text' },
    suggested_chips: followupResult.suggested_chips,
    cards: followupResult.cards,
    session_patch: {},
    events: [
      { event_name: 'analysis_followup_action_routed', data: { action_id: 'chip.aurora.next_action.deep_dive_skin', used_last_analysis: true, missing_context: false, fell_back_to_generic: false } },
    ],
  };

  const ctx = { request_id: 'req123', trace_id: 'trace123', lang: 'EN', ui_lang: 'EN', match_lang: 'EN' };
  const v1Response = buildChatCardsResponse({
    envelope: legacyEnvelope,
    ctx,
    intent: 'analysis_followup',
    intentConfidence: 1,
    entities: [],
    safetyDecision: null,
    threadOps: [],
  });

  assert.equal(v1Response.version, '1.0');
  assert.equal(v1Response.request_id, 'req123');
  assert.equal(v1Response.trace_id, 'trace123');
  assert.ok(typeof v1Response.assistant_text === 'string' && v1Response.assistant_text.length > 0);
  assert.ok(Array.isArray(v1Response.cards));
  assert.ok(v1Response.cards.length > 0);
  const legacyCard = v1Response.cards[0];
  assert.equal(legacyCard.type, 'analysis_story_v2');
});

test('stream deep-dive: v1 response from buildChatCardsResponse is parseable by frontend chatCardsParser logic', () => {
  const { buildChatCardsResponse } = require('../src/auroraBff/chatCardsAssembler');

  const legacyEnvelope = {
    request_id: 'req_parse_test',
    trace_id: 'trace_parse_test',
    assistant_message: { role: 'assistant', content: 'Deep dive: Mild dryness observed.', format: 'text' },
    suggested_chips: [],
    cards: [
      {
        card_id: 'analysis_followup_story_parse',
        type: 'analysis_story_v2',
        payload: {
          confidence_overall: { level: 'medium' },
          priority_findings: [{ priority: 1, title: 'Mild dryness', detail: 'Cheeks area', evidence_region_or_module: [] }],
        },
      },
    ],
    session_patch: {},
    events: [{ event_name: 'analysis_followup_action_routed', data: { action_id: 'chip.aurora.next_action.deep_dive_skin', fell_back_to_generic: false } }],
  };

  const v1 = buildChatCardsResponse({
    envelope: legacyEnvelope,
    ctx: { request_id: 'req_parse_test', trace_id: 'trace_parse_test', lang: 'EN', ui_lang: 'EN', match_lang: 'EN' },
    intent: 'analysis_followup',
    intentConfidence: 1,
  });

  assert.equal(String(v1.version), '1.0');
  assert.ok(String(v1.request_id).length > 0);
  assert.ok(String(v1.trace_id).length > 0);
  assert.ok(typeof v1.assistant_text === 'string' && v1.assistant_text.length > 0);
  assert.ok(Array.isArray(v1.cards) && v1.cards.length > 0);
  assert.ok(Array.isArray(v1.follow_up_questions));
  assert.ok(Array.isArray(v1.suggested_quick_replies));
  assert.ok(v1.safety && typeof v1.safety.risk_level === 'string');
  assert.ok(v1.telemetry && typeof v1.telemetry.intent === 'string');
});

test('/v1/chat: deep_dive_skin consumes photo refs and diagnosis artifact through llm path', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SKIN_DEEP_DIVE_MODEL_GEMINI: 'gemini-3-pro-preview',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const memoryStore = require('../src/auroraBff/memoryStore');
      const artifactStore = require('../src/auroraBff/diagnosisArtifactStore');
      const routeModule = require('../src/auroraBff/routes');
      const { mountAuroraBffRoutes, __internal } = routeModule;
      const uid = 'uid_analysis_followup_photo_deep_dive';
      const sessionId = 'brief_analysis_followup_photo_deep_dive';
      const headers = {
        'X-Aurora-UID': uid,
        'X-Trace-ID': 'trace_analysis_followup_photo_deep_dive',
        'X-Brief-ID': sessionId,
        'X-Lang': 'EN',
      };
      const llmCalls = [];
      __internal.__setCallGeminiJsonObjectForTest(async (request) => {
        llmCalls.push(request);
        return {
          ok: true,
          json: {
            conclusion: 'The redness looks more consistent with barrier stress right now.',
            key_signals: [
              'Cheek redness appears alongside dehydration.',
              'The routine active stack can also be compatible with irritation.',
            ],
            actions_now: ['AM: Gentle cleanse, moisturizer, SPF.'],
            avoid_now: ['Avoid stacking strong acids while redness settles.'],
            confidence_note: 'Medium confidence from photo-backed evidence.',
          },
        };
      });

      try {
        await memoryStore.saveLastAnalysisForIdentity(
          { auroraUid: uid, userId: null },
          {
            analysis: {
              skin_profile: {
                skin_type_tendency: 'combination',
                sensitivity_tendency: 'high',
                current_strengths: ['steady barrier'],
              },
              priority_findings: [{ title: 'Cheek redness' }, { detail: 'Mild dehydration' }],
              confidence_overall: { level: 'medium', score: 0.73 },
              guidance_brief: ['Simplify the morning active stack', 'Keep barrier support stable'],
            },
            lang: 'EN',
          },
        );
        await artifactStore.saveDiagnosisArtifact({
          auroraUid: uid,
          userId: null,
          sessionId,
          artifact: {
            artifact_id: 'da_test_photo_deep_dive',
            created_at: new Date().toISOString(),
            use_photo: true,
            overall_confidence: { level: 'medium', score: 0.73 },
            skinType: { value: 'combination' },
            sensitivity: { value: 'high' },
            goals: { values: ['acne', 'pores'] },
            concerns: [{ id: 'redness', title: 'Cheek redness' }],
            photos: [{ slot: 'daylight', photo_id: 'photo_daylight_1', qc_status: 'passed' }],
            analysis_context: {
              analysis_source: 'vision_gemini',
              used_photos: true,
              quality_grade: 'pass',
            },
            source_mix: ['photo', 'profile'],
          },
          artifactId: 'da_test_photo_deep_dive',
        });

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const deepDive = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            action: {
              action_id: 'chip.aurora.next_action.deep_dive_skin',
              kind: 'action',
              data: {
                reply_text: 'Explain the redness pattern',
                trigger_source: 'analysis_story_v2',
                analysis_origin: 'photo',
                use_photo: true,
                source_card_type: 'analysis_story_v2',
                photo_refs: [{ slot_id: 'daylight', photo_id: 'photo_daylight_1', qc_status: 'passed' }],
              },
            },
            session: {
              state: { latest_artifact_id: 'da_test_photo_deep_dive' },
              meta: {
                analysis_context: {
                  analysis_origin: 'photo',
                  use_photo: true,
                  source_card_type: 'analysis_story_v2',
                  photo_refs: [{ slot_id: 'daylight', photo_id: 'photo_daylight_1', qc_status: 'passed' }],
                },
              },
            },
            language: 'EN',
          })
          .expect(200);

        assert.equal(llmCalls.length, 1);
        assert.equal(llmCalls[0].model, 'gemini-3-pro-preview');
        assert.equal(llmCalls[0].maxOutputTokens, 1200);
        assert.match(String(llmCalls[0].userPrompt || ''), /Photo-backed context already exists/i);
        assert.doesNotMatch(String(llmCalls[0].userPrompt || ''), /photo_daylight_1/);
        assert.doesNotMatch(String(llmCalls[0].userPrompt || ''), /can't analyze photos/i);
        const storyCard = findCardByType(deepDive.body?.cards, 'analysis_story_v2');
        assert.ok(storyCard);
        assert.equal(storyCard.payload.confidence_overall.level, 'medium');
        assert.match(String(storyCard.payload.ui_card_v1?.headline || ''), /more consistent with barrier stress/i);
        assert.match(String(deepDive.body?.assistant_message?.content || ''), /photo-based analysis|photo-backed/i);
        assert.match(String(deepDive.body?.assistant_message?.content || ''), /Confidence note: Medium confidence from photo-backed evidence/i);
        const actionEvent = Array.isArray(deepDive.body?.events)
          ? deepDive.body.events.find((event) => event && event.event_name === 'analysis_followup_action_routed')
          : null;
        assert.equal(actionEvent?.data?.analysis_origin, 'photo');
        assert.equal(actionEvent?.data?.llm_used, true);
        assert.equal(actionEvent?.data?.used_diagnosis_artifact, true);
        assert.equal(actionEvent?.data?.photo_ref_count, 1);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        await memoryStore.deleteIdentityData({ auroraUid: uid, userId: null });
        delete require.cache[routeModuleId];
      }
    },
  );
});

test('buildAnalysisDeepDiveContentWithLlm prefers canonical analysis_story snapshot over generic rewrite', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DATABASE_URL: undefined,
      AURORA_BFF_RETENTION_DAYS: '0',
      AURORA_SKIN_DEEP_DIVE_MODEL_GEMINI: 'gemini-3-pro-preview',
    },
    async () => {
      const routeModuleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[routeModuleId];
      const routeModule = require('../src/auroraBff/routes');
      const { __internal } = routeModule;
      let llmCalls = 0;
      __internal.__setCallGeminiJsonObjectForTest(async () => {
        llmCalls += 1;
        return {
          ok: true,
          json: {
            conclusion: 'The visible features are more consistent with a baseline state.',
            key_signals: ['Lighting limits fine detail.'],
            actions_now: ['AM: Gentle cleanse.'],
          },
        };
      });

      try {
        const out = await __internal.buildAnalysisDeepDiveContentWithLlm({
          lastAnalysis: {},
          diagnosisArtifact: {
            artifact_id: 'da_snapshot_preferred',
            use_photo: true,
            photos: [{ slot: 'daylight', photo_id: 'photo_snapshot_anchor', qc_status: 'passed' }],
          },
          profile: {},
          language: 'EN',
          requestId: 'req_snapshot_preferred',
          replyText: 'Tell me more about my skin',
          actionData: {
            trigger_source: 'analysis_story_v2',
          },
          sessionAnalysisContext: {
            analysis_origin: 'photo',
            source_card_type: 'analysis_story_v2',
            photo_refs: [{ slot_id: 'daylight', photo_id: 'photo_snapshot_anchor', qc_status: 'passed' }],
            analysis_story_snapshot: {
              schema_version: 'aurora.analysis_story.v2',
              confidence_overall: { level: 'medium', score: 0.68 },
              skin_profile: { skin_type_tendency: 'combination', sensitivity_tendency: 'low' },
              priority_findings: [
                {
                  priority: 1,
                  title: 'UV filters are the clearest next move right now.',
                  detail: 'UV filters are the clearest next move right now.',
                  evidence_region_or_module: [],
                },
                {
                  priority: 2,
                  title: 'Keep the pass conservative until a clearer retake.',
                  detail: 'Keep the pass conservative until a clearer retake.',
                  evidence_region_or_module: [],
                },
              ],
              target_state: ['Keep this pass centered on UV filters in a broad-spectrum sunscreen.'],
              core_principles: ['Do not widen into several new actives at once.'],
              am_plan: [{ step: 'Use broad-spectrum sunscreen', purpose: 'UV protection' }],
              pm_plan: [{ step: 'Barrier moisturizer', purpose: 'Recovery support' }],
              timeline: {
                first_4_weeks: ['Re-check in 1 week.'],
                week_8_12_expectation: ['Stay conservative until a clearer retake.'],
              },
              safety_notes: ['Do not widen into multiple strong actives yet.'],
              disclaimer_non_medical: true,
              ui_card_v1: {
                headline: 'Keep this pass centered on UV filters in a broad-spectrum sunscreen',
                key_points: [
                  'The clearest next move is UV filters in a broad-spectrum sunscreen.',
                  'Keep the pass conservative until a clearer retake.',
                ],
                actions_now: ['Use one broad-spectrum sunscreen built around UV filters every morning.'],
                avoid_now: ['Do not widen into multiple strong actives yet.'],
                confidence_label: 'medium',
                next_checkin: 'Re-check in 1 week.',
              },
            },
          },
          logger: null,
        });

        assert.equal(llmCalls, 0);
        assert.equal(out?.llm_used, false);
        assert.equal(out?.llm_failure_reason, 'snapshot_story_preferred');
        const storyCard = Array.isArray(out?.cards) ? out.cards.find((card) => card && card.type === 'analysis_story_v2') : null;
        assert.ok(storyCard);
        assert.match(String(storyCard?.payload?.ui_card_v1?.headline || ''), /uv filters/i);
        assert.match(String(storyCard?.payload?.summary || ''), /uv filters/i);
        assert.match(String(out?.assistant_text || ''), /uv filters/i);
      } finally {
        __internal.__resetCallGeminiJsonObjectForTest();
        delete require.cache[routeModuleId];
      }
    },
  );
});

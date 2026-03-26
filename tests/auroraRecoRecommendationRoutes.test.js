const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountRecoRecommendationRoutes } = require('../src/auroraBff/routes/recoRecommendationRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn(), info: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_reco_generate_1',
      trace_id: 'trace_reco_generate_1',
      aurora_uid: 'uid_reco_generate_1',
      lang: 'EN',
      trigger_source: 'action',
    })),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    requireAuroraUid: jest.fn(),
    resolveIdentity: jest.fn(async () => ({ auroraUid: 'uid_reco_generate_1', userId: 'user_reco_generate_1' })),
    getProfileForIdentity: jest.fn(async () => ({ concerns: ['acne'] })),
    getRecentSkinLogsForIdentity: jest.fn(async () => [{ reaction: 'dryness' }]),
    summarizeProfileForContext: jest.fn((profile) => ({ summary: profile ? 'profile_present' : 'profile_missing' })),
    shouldDiagnosisGate: jest.fn(() => ({ gated: false, missing: [] })),
    buildDiagnosisPrompt: jest.fn(() => 'complete diagnosis'),
    buildDiagnosisChips: jest.fn(() => [{ chip_id: 'chip.refine_profile' }]),
    buildConfidenceNoticeCardPayload: jest.fn((payload) => payload),
    buildRecoGenerateUserAsk: jest.fn(() => 'recommend something'),
    generateProductRecommendations: jest.fn(async () => ({
      norm: {
        payload: {
          recommendations: [{ product_id: 'prod_1' }],
          grounded_count: 1,
          ungrounded_count: 0,
          recommendation_meta: { source_mode: 'catalog_grounded_v1' },
        },
        field_missing: [],
      },
    })),
    normalizeRecoGenerate: jest.fn(() => ({
      payload: { recommendations: [] },
      field_missing: [],
    })),
    enrichRecommendationsWithAlternatives: jest.fn(async ({ recommendations }) => ({
      recommendations,
      field_missing: [],
    })),
    mergeFieldMissing: jest.fn((left, right) => [...(left || []), ...(right || [])]),
    isPlainObject: jest.fn((value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)),
    buildRecoEntryChips: jest.fn(() => [{ chip_id: 'chip.start.reco_products' }]),
    deriveRecoEmptyReason: jest.fn(() => 'artifact_missing'),
    applyRecommendationOutputGuardrailsForRoute: jest.fn(async ({ envelope }) => ({ envelope, rejected: [] })),
    persistRejectedCatalogCandidates: jest.fn(),
    RecoGenerateRequestSchema: z.object({
      focus: z.string().optional(),
      constraints: z.record(z.string(), z.any()).optional(),
      include_alternatives: z.boolean().optional(),
    }),
    RecoAlternativesRequestSchema: z.object({
      product_input: z.string().optional(),
      anchor_product_id: z.string().optional(),
      product: z.record(z.string(), z.any()).optional(),
      include_debug: z.boolean().optional(),
      max_total: z.number().optional(),
    }),
    buildProductInputText: jest.fn((productObj) => String(productObj?.name || '').trim()),
    extractAnchorIdFromProductLike: jest.fn((productObj) => String(productObj?.product_id || '').trim()),
    coerceBoolean: jest.fn((value) => ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())),
    fetchRecoAlternativesForProduct: jest.fn(async () => ({
      ok: true,
      alternatives: [{ product_id: 'alt_1' }],
      field_missing: [],
      source_mode: 'selector_grounded',
      fallback_source: null,
      refresh_pending: false,
      refresh_after_ms: 0,
      failure_class: null,
      attempt_count: 1,
      prompt_contract_ok: true,
      prompt_contract_issues: [],
      no_result_reason: null,
      timeout_root_cause: null,
      llm_trace: { provider: 'stub' },
      debug: { source: 'debug_enabled' },
    })),
    auroraRecoGenerateGuardrailV1: true,
  };

  mountRecoRecommendationRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountRecoRecommendationRoutes', () => {
  test('reco generate keeps next_state when guarded recommendations remain', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/reco/generate')
      .send({
        focus: 'hydration',
        constraints: { avoid: ['fragrance'] },
      })
      .expect(200);

    expect(res.body.cards[0].type).toBe('recommendations');
    expect(res.body.session_patch).toEqual({ next_state: 'S7_PRODUCT_RECO' });
    expect(deps.generateProductRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'recommend something',
        recoTriggerSource: 'goal_driven',
      }),
    );
    expect(deps.applyRecommendationOutputGuardrailsForRoute).toHaveBeenCalled();
  });

  test('reco generate repopulates entry chips when guardrail removes recommendations', async () => {
    const { app } = buildApp({
      shouldDiagnosisGate: jest.fn(() => ({ gated: true, missing: ['skinType'] })),
      generateProductRecommendations: jest.fn(async () => ({
        norm: {
          payload: {
            recommendations: [],
            grounded_count: 0,
            ungrounded_count: 0,
            products_empty_reason: 'artifact_missing',
            recommendation_meta: { source_mode: 'catalog_grounded_v1' },
          },
          field_missing: [],
        },
      })),
      applyRecommendationOutputGuardrailsForRoute: jest.fn(async ({ envelope }) => ({
        envelope: {
          ...envelope,
          suggested_chips: [],
          cards: Array.isArray(envelope.cards)
            ? envelope.cards.map((card) =>
                card && card.type === 'recommendations'
                  ? { ...card, payload: { ...card.payload, recommendations: [] } }
                  : card,
              )
            : [],
          session_patch: {},
        },
        rejected: [],
      })),
    });

    const res = await request(app)
      .post('/v1/reco/generate')
      .send({ focus: 'barrier repair' })
      .expect(200);

    expect(Array.isArray(res.body.suggested_chips)).toBe(true);
    expect(res.body.suggested_chips[0].chip_id).toBe('chip.start.reco_products');
    expect(res.body.session_patch).toEqual({});
  });

  test('reco alternatives normalizes output and includes debug payload when requested', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/reco/alternatives')
      .set('X-Debug', 'true')
      .send({
        product: { name: 'Peptide serum', product_id: 'prod_anchor_1' },
        max_total: 12,
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.alternatives).toEqual([{ product_id: 'alt_1' }]);
    expect(res.body.debug).toEqual({ source: 'debug_enabled' });
    expect(deps.fetchRecoAlternativesForProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        productInput: 'Peptide serum',
        anchorId: 'prod_anchor_1',
        maxTotal: 8,
        debug: true,
      }),
    );
  });
});

const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountDupeRoutes } = require('../src/auroraBff/routes/dupeRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_dupe_1',
      trace_id: 'trace_dupe_1',
      aurora_uid: 'uid_dupe_1',
      lang: 'EN',
      state: 'idle',
      trigger_source: 'manual',
    })),
    requireAuroraUid: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    buildProductInputText: jest.fn((productLike, productUrl) => {
      if (productLike && typeof productLike === 'object' && !Array.isArray(productLike)) {
        return [productLike.brand, productLike.name, productLike.sku_id, productLike.product_id]
          .filter(Boolean)
          .join(' ');
      }
      return typeof productUrl === 'string' ? productUrl.trim() : '';
    }),
    extractAnchorIdFromProductLike: jest.fn((productLike) => productLike?.sku_id || productLike?.product_id || null),
    normalizeDupeKbKey: jest.fn((value) => String(value || '').trim().toLowerCase()),
    getDupeKbEntry: jest.fn(async () => ({
      original: { sku_id: 'orig_1', brand: 'OrigBrand', name: 'Original Cleanser' },
      dupes: [{ sku_id: 'dupe_1', brand: 'DupeBrand', name: 'Budget Cleanser' }],
      comparables: [],
      verified: true,
      verified_at: '2026-03-23T00:00:00.000Z',
      source: 'kb',
    })),
    applyDupeSuggestSanitizeToEnvelope: jest.fn((envelope) => ({ envelope })),
    buildContextPrefix: jest.fn(() => ''),
    auroraChat: jest.fn(async () => null),
    AURORA_DECISION_BASE_URL: 'http://aurora.test',
    getUpstreamStructuredOrJson: jest.fn(() => null),
    extractJsonObjectByKeys: jest.fn(() => null),
    fetchRecoAlternativesForProduct: jest.fn(async () => ({ alternatives: [], field_missing: [] })),
    DUPE_KB_ASYNC_BACKFILL_ENABLED: false,
    AURORA_DUPE_SUGGEST_SANITIZE_V1: true,
    upsertDupeKbEntry: jest.fn(async () => null),
    resolveIdentity: jest.fn(async () => ({ auroraUid: 'uid_dupe_1', userId: 'user_dupe_1' })),
    getProfileForIdentity: jest.fn(async () => null),
    getRecentSkinLogsForIdentity: jest.fn(async () => []),
    summarizeProfileForContext: jest.fn(() => null),
    mapAuroraProductAnalysis: jest.fn(() => ({
      evidence: {
        science: {
          key_ingredients: [],
          mechanisms: [],
          fit_notes: [],
          risk_notes: [],
        },
        social_signals: {
          typical_positive: [],
          typical_negative: [],
          risk_for_groups: [],
        },
        expert_notes: [],
      },
      confidence: 0.5,
    })),
    mapAuroraAlternativesToDupeCompare: jest.fn(() => ({
      original: { sku_id: 'orig_1', brand: 'OrigBrand', name: 'Original Cleanser' },
      dupe: { sku_id: 'dupe_1', brand: 'DupeBrand', name: 'Budget Cleanser' },
      tradeoffs: ['Budget option has a lighter finish.'],
      evidence: {
        science: { key_ingredients: [] },
        social_signals: {},
        expert_notes: [],
      },
      confidence: 0.7,
    })),
    normalizeDupeCompare: jest.fn((raw) => ({
      payload: {
        original: raw.original || null,
        dupe: raw.dupe || null,
        tradeoffs: Array.isArray(raw.tradeoffs) ? raw.tradeoffs : [],
        evidence: raw.evidence || null,
        confidence: raw.confidence ?? null,
        missing_info: Array.isArray(raw.missing_info) ? raw.missing_info : [],
      },
      field_missing: [],
    })),
    mergeFieldMissing: jest.fn((left, right) => [
      ...(Array.isArray(left) ? left : []),
      ...(Array.isArray(right) ? right : []),
    ]),
    getDupeDeepscanCache: jest.fn(() => null),
    setDupeDeepscanCache: jest.fn(),
    DupeSuggestRequestSchema: z.object({
      original: z
        .object({
          sku_id: z.string().optional(),
          product_id: z.string().optional(),
          brand: z.string().optional(),
          name: z.string().optional(),
        })
        .optional(),
      original_url: z.string().optional(),
      original_text: z.string().optional(),
      max_dupes: z.number().optional(),
      max_comparables: z.number().optional(),
      force_refresh: z.boolean().optional(),
      force_validate: z.boolean().optional(),
    }),
    DupeCompareRequestSchema: z.object({
      original: z
        .object({
          sku_id: z.string().optional(),
          product_id: z.string().optional(),
          brand: z.string().optional(),
          name: z.string().optional(),
        })
        .optional(),
      original_url: z.string().optional(),
      dupe: z
        .object({
          sku_id: z.string().optional(),
          product_id: z.string().optional(),
          brand: z.string().optional(),
          name: z.string().optional(),
        })
        .optional(),
      dupe_url: z.string().optional(),
    }),
  };

  mountDupeRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountDupeRoutes', () => {
  test('dupe suggest serves verified KB payload through the dedicated owner', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/dupe/suggest')
      .send({
        original: { sku_id: 'orig_1', brand: 'OrigBrand', name: 'Original Cleanser' },
      })
      .expect(200);

    expect(res.body.cards[0].type).toBe('dupe_suggest');
    expect(res.body.cards[0].payload.meta).toMatchObject({
      served_from_kb: true,
      validated_now: false,
    });
    expect(deps.applyDupeSuggestSanitizeToEnvelope).toHaveBeenCalled();
  });

  test('dupe compare returns BAD_REQUEST when original and dupe inputs are absent', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/dupe/compare')
      .send({})
      .expect(400);

    expect(res.body.cards[0].payload.error).toBe('BAD_REQUEST');
  });
});

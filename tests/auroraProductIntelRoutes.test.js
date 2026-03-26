const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountProductIntelRoutes } = require('../src/auroraBff/routes/productIntelRoutes');

function buildDeps(overrides = {}) {
  const baseDeps = {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_product_intel_1',
      trace_id: 'trace_product_intel_1',
      aurora_uid: 'uid_product_intel_1',
      lang: 'EN',
      trigger_source: 'manual',
      state: 'idle',
    })),
    requireAuroraUid: jest.fn(),
    ProductParseRequestSchema: z.object({
      text: z.string().min(1).optional(),
      url: z.string().optional(),
      llm_provider: z.string().optional(),
      llm_model: z.string().optional(),
    }).refine((value) => Boolean(value.text || value.url), {
      message: 'text_or_url_required',
    }),
    ProductAnalyzeRequestSchema: z.object({
      name: z.string().min(1).optional(),
      url: z.string().optional(),
      product: z.record(z.any()).optional(),
      session: z.record(z.any()).optional(),
      llm_provider: z.string().optional(),
      llm_model: z.string().optional(),
    }).refine((value) => Boolean(value.name || value.url || value.product), {
      message: 'product_input_required',
    }),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => text),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    resolveProductIntelLlmRoute: jest.fn(() => ({})),
    AURORA_DECISION_BASE_URL: 'http://aurora.test',
    AURORA_CHAT_UPSTREAM_TIMEOUT_MS: 1200,
    auroraChat: jest.fn(async () => ({
      structured: {
        product: {
          product_id: 'prod_1',
          name: 'Demo Serum',
        },
        confidence: 0.84,
        missing_info: [],
      },
    })),
    getUpstreamStructuredOrJson: jest.fn((upstream) => upstream?.structured || null),
    PRODUCT_PARSE_ANSWER_JSON_KEYS: ['product', 'confidence', 'missing_info'],
    mapAuroraProductParse: jest.fn((value) => value),
    normalizeProductParse: jest.fn((value) => ({
      payload: {
        product: value?.product || null,
        confidence: Number.isFinite(Number(value?.confidence)) ? Number(value.confidence) : 0.84,
        missing_info: Array.isArray(value?.missing_info) ? value.missing_info : [],
      },
      field_missing: [],
    })),
    evaluateAnchorTrustForProductIntel: jest.fn(({ candidate }) => ({
      trusted_anchor: candidate || null,
      display_anchor: candidate || null,
      usable_for_anchor_id: true,
      trust_level: 'high',
      reason_codes: [],
      source: 'test',
      candidate_quality: 'high',
      url_consistency: 1,
    })),
    AURORA_PRODUCT_STRICT_SKINCARE_FILTER: true,
    uniqCaseInsensitiveStrings: jest.fn((items) => Array.from(new Set((items || []).filter(Boolean)))),
    AURORA_RULE_RELAX_AGGRESSIVE: false,
    buildHeuristicProductFromInput: jest.fn(() => null),
    resolveCatalogProductForProductInput: jest.fn(async () => ({ ok: false, reason: 'fallback_disabled' })),
    mapCatalogParseMissingReason: jest.fn(() => 'catalog_fallback_disabled'),
    mapCatalogProductToAnchorProduct: jest.fn(() => null),
    CATALOG_AVAIL_SEARCH_TIMEOUT_MS: 400,
    PRODUCT_INTEL_CATALOG_FALLBACK_ENABLED: false,
    getRecoDogfoodSessionId: jest.fn(() => 'sess_product_intel_1'),
    applyUnknownVerdictQualityGateToEnvelope: jest.fn((envelope) => envelope),
    augmentEnvelopeProductAnalysisCardsForDogfood: jest.fn(({ envelope }) => envelope),
    augmentEnvelopeProductAnalysisCardsWithPrelabelSuggestions: jest.fn(async ({ envelope }) => envelope),
    isPlainObject: jest.fn((value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)),
  };

  const merged = {
    ...baseDeps,
    ...overrides,
  };

  return new Proxy(merged, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return target[prop];
      return jest.fn(async () => null);
    },
  });
}

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const deps = buildDeps(overrides);
  mountProductIntelRoutes(app, deps);
  return { app, deps };
}

describe('mountProductIntelRoutes', () => {
  test('product parse invalid request returns BAD_REQUEST envelope', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/product/parse')
      .send({})
      .expect(400);

    expect(res.body.cards[0].type).toBe('error');
    expect(res.body.cards[0].payload.error).toBe('BAD_REQUEST');
  });

  test('product parse structured happy path returns product_parse card', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/product/parse')
      .send({ text: 'Demo Serum' })
      .expect(200);

    expect(deps.auroraChat).toHaveBeenCalled();
    expect(res.body.cards[0].type).toBe('product_parse');
    expect(res.body.cards[0].payload.product).toEqual(
      expect.objectContaining({
        product_id: 'prod_1',
        name: 'Demo Serum',
      }),
    );
    expect(res.body.cards[0].payload.parse_source).toBe('upstream_structured');
  });

  test('product analyze invalid request returns BAD_REQUEST envelope', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/product/analyze')
      .send({})
      .expect(400);

    expect(res.body.cards[0].type).toBe('error');
    expect(res.body.cards[0].payload.error).toBe('BAD_REQUEST');
  });
});

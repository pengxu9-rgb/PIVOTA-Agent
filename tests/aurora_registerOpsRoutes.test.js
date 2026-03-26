const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { registerAuroraOpsRoutes } = require('../src/auroraBff/registerOpsRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    app,
    logger: { warn: jest.fn(), info: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      lang: 'EN',
      match_lang: 'EN',
      request_id: 'req_ops_1',
      aurora_uid: 'uid_ops_1',
    })),
    renderVisionMetricsPrometheus: jest.fn(() => 'vision_metric 1\n'),
    renderRecoPdpFallbackMetricsPrometheus: jest.fn(() => 'reco_metric 1\n'),
    renderChatQualityMetricsPrometheus: jest.fn(() => 'quality_metric 1\n'),
    renderGeminiQaMetricsPrometheus: jest.fn(() => 'qa_metric 1\n'),
    auroraBffQaGateAdminKey: 'qa_key',
    hasQaGateAdminAccess: jest.fn((req) => req.get('X-Aurora-Admin-Key') === 'qa_key'),
    getGeminiGlobalGate: jest.fn(() => ({ snapshot: () => ({ state: 'open' }) })),
    getQaRouteObservabilitySnapshot: jest.fn(() => ({ requests: 1 })),
    auroraBffPdpHotsetPrewarmAdminKey: 'prefetch_key',
    hasPdpHotsetPrewarmAdminAccess: jest.fn((req) => req.get('X-Aurora-Admin-Key') === 'prefetch_key'),
    getPdpPrefetchStateSnapshot: jest.fn(() => ({ runtime: { totals: { total: 1 } } })),
    normalizePdpPrefetchReason: jest.fn((reason) => String(reason || '').trim().toLowerCase()),
    runPdpHotsetPrewarmBatch: jest.fn(async ({ reason }) => ({ ok: true, reason })),
    recoDogfoodConfig: {
      dogfood_mode: true,
      prelabel: {
        enabled: true,
        max_candidates_per_block: { competitors: 3 },
        ttl_ms: 60000,
        timeout_ms: 4000,
      },
    },
    auroraBffRecoPrelabelAdminKey: 'reco_key',
    hasRecoPrelabelAdminAccess: jest.fn((req) => req.get('X-Aurora-Admin-Key') === 'reco_key'),
    InternalPrelabelRequestSchema: z.object({
      anchor_product_id: z.string(),
      blocks: z.array(z.string()).optional(),
      max_candidates_per_block: z.record(z.number()).optional(),
      force_refresh: z.boolean().optional(),
      snapshot_payload: z.record(z.any()).optional(),
      request_id: z.string().optional(),
      session_id: z.string().optional(),
    }),
    PrelabelSuggestionsQuerySchema: z.object({
      anchor_product_id: z.string(),
      block: z.string().optional(),
      limit: z.any().optional(),
    }),
    LabelQueueQuerySchema: z.object({
      block: z.string().optional(),
      limit: z.any().optional(),
      anchor_product_id: z.string().optional(),
      low_confidence: z.any().optional(),
      wrong_block_only: z.any().optional(),
      exploration_only: z.any().optional(),
      missing_info_only: z.any().optional(),
    }),
    generatePrelabelsForAnchor: jest.fn(async () => ({
      ok: true,
      requested_by_block: { competitors: 1, dupes: 0, related_products: 0 },
      generated_by_block: { competitors: 1, dupes: 0, related_products: 0 },
      invalid_json_by_block: { competitors: 0, dupes: 0, related_products: 0 },
      cache_hit_by_block: { competitors: 0, dupes: 0, related_products: 0 },
      suggestions_by_block: { competitors: [], dupes: [], related_products: [] },
      gemini_latency_ms: [12],
      candidates_total: 1,
      cache_hit_count: 0,
    })),
    loadSuggestionsForAnchor: jest.fn(async () => []),
    buildPrelabelKbReadCandidates: jest.fn(() => []),
    getProductIntelKbEntry: jest.fn(async () => null),
    sanitizeProductAnalysisPayloadForPrelabel: jest.fn((payload) => payload),
    attachPrelabelSuggestionsToPayload: jest.fn((payload, suggestions) => ({
      ...payload,
      suggestions,
    })),
    mapSuggestionForResponse: jest.fn((row) => row),
    parseIntQueryValue: jest.fn((value, fallback) => Number(value || fallback)),
    parseBoolQueryValue: jest.fn((value, fallback = false) =>
      value == null ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()),
    ),
    listQueueCandidatesWithSuggestions: jest.fn(async () => []),
    buildLabelQueue: jest.fn(() => []),
    normalizeBlockToken: jest.fn((value) => String(value || '').trim().toLowerCase() || null),
    recordPrelabelRequest: jest.fn(),
    recordPrelabelSuccess: jest.fn(),
    recordPrelabelInvalidJson: jest.fn(),
    recordPrelabelCacheHit: jest.fn(),
    observePrelabelGeminiLatency: jest.fn(),
    recordSuggestionsGeneratedPerBlock: jest.fn(),
    setPrelabelCacheHitRate: jest.fn(),
    recordQueueItemsServed: jest.fn(),
    prelabelPromptVersion: 'prelabel_v1',
  };

  registerAuroraOpsRoutes({
    ...deps,
    ...overrides,
  });

  return { app, deps };
}

describe('registerAuroraOpsRoutes', () => {
  test('registers metrics route and returns combined prometheus payload', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/metrics').expect(200);

    expect(res.text).toContain('vision_metric 1');
    expect(res.text).toContain('reco_metric 1');
    expect(res.text).toContain('quality_metric 1');
    expect(res.text).toContain('qa_metric 1');
  });

  test('gates pdp-prefetch state by admin access and returns snapshot when authorized', async () => {
    const { app, deps } = buildApp();

    await request(app)
      .get('/v1/ops/pdp-prefetch/state')
      .set('X-Aurora-Admin-Key', 'wrong')
      .expect(403);

    const res = await request(app)
      .get('/v1/ops/pdp-prefetch/state')
      .set('X-Aurora-Admin-Key', 'prefetch_key')
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ runtime: { totals: { total: 1 } } });
    expect(deps.getPdpPrefetchStateSnapshot).toHaveBeenCalled();
  });

  test('runs internal prelabel route through dedicated owner', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/internal/prelabel')
      .set('X-Aurora-Admin-Key', 'reco_key')
      .send({
        anchor_product_id: 'anchor_1',
        blocks: ['competitors'],
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(deps.generatePrelabelsForAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor_product_id: 'anchor_1',
        blocks: ['competitors'],
        prompt_version: 'prelabel_v1',
        request_id: 'req_ops_1',
        session_id: 'uid_ops_1',
      }),
    );
  });
});

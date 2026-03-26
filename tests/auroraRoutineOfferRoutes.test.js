const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountRoutineOfferRoutes } = require('../src/auroraBff/routes/routineOfferRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn(), error: jest.fn() },
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_routine_offer_1',
      trace_id: 'trace_routine_offer_1',
      aurora_uid: 'uid_routine_offer_1',
      lang: 'EN',
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
    simulateConflicts: jest.fn(() => ({
      safe: false,
      conflicts: [{ rule_id: 'retinoid_x_acids', severity: 'block' }],
      summary: { headline: 'conflict' },
    })),
    buildHeatmapStepsFromRoutine: jest.fn(() => [{ slot: 'pm_1' }]),
    buildConflictHeatmapV1: jest.fn(() => ({
      schema_version: 'aurora.ui.conflict_heatmap.v1',
      state: 'ok',
      axes: { rows: { items: [{ step_id: 'pm_1' }] } },
      cells: { items: [{ severity: 3 }] },
      unmapped_conflicts: [],
    })),
    applyOfferItemPdpOpenContract: jest.fn((item, meta = {}) => ({ ...item, _meta: meta })),
    mapOfferResolveFailureCode: jest.fn(() => 'db_error'),
    summarizeOfferPdpOpen: jest.fn(() => ({
      path_stats: { internal: 1 },
      fail_reason_counts: {},
      time_to_pdp_ms_stats: { count: 1 },
    })),
    schedulePdpCorePrefetchFromItems: jest.fn(),
    RoutineSimulateRequestSchema: z.object({
      routine: z.record(z.string(), z.any()).optional(),
      test_product: z.record(z.string(), z.any()).nullable().optional(),
    }),
    OffersResolveRequestSchema: z.object({
      market: z.string().optional(),
      items: z.array(
        z.object({
          product: z.record(z.string(), z.any()),
          offer: z.record(z.string(), z.any()),
        }),
      ).min(1),
    }),
    AffiliateOutcomeRequestSchema: z.object({
      outcome: z.string(),
      url: z.string().optional(),
    }),
    CONFLICT_HEATMAP_V1_ENABLED: true,
    USE_AURORA_BFF_MOCK: true,
    PIVOTA_BACKEND_BASE_URL: '',
  };

  mountRoutineOfferRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountRoutineOfferRoutes', () => {
  test('routine simulate returns routine_simulation and conflict_heatmap cards', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/routine/simulate')
      .send({
        routine: { pm: [{ key_actives: ['retinol'] }] },
        test_product: { key_actives: ['glycolic acid'] },
      })
      .expect(200);

    expect(deps.simulateConflicts).toHaveBeenCalled();
    expect(res.body.cards.map((card) => card.type)).toEqual(
      expect.arrayContaining(['routine_simulation', 'conflict_heatmap']),
    );
  });

  test('offers resolve mock mode returns offers_resolved payload', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/offers/resolve')
      .send({
        market: 'US',
        items: [
          {
            product: { sku_id: 'sku_1', name: 'Old', brand: 'OldBrand', image_url: '' },
            offer: { affiliate_url: 'https://example.com/p/1', price: 0, currency: 'USD', seller: 'X' },
          },
        ],
      })
      .expect(200);

    expect(deps.applyOfferItemPdpOpenContract).toHaveBeenCalled();
    expect(deps.schedulePdpCorePrefetchFromItems).toHaveBeenCalled();
    expect(res.body.cards[0].type).toBe('offers_resolved');
    expect(res.body.cards[0].payload.market).toBe('US');
  });

  test('affiliate outcome invalid request returns BAD_REQUEST envelope', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/affiliate/outcome')
      .send({})
      .expect(400);

    expect(res.body.cards[0].type).toBe('error');
    expect(res.body.cards[0].payload.error).toBe('BAD_REQUEST');
  });

  test('affiliate outcome happy path returns affiliate_outcome card', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/v1/affiliate/outcome')
      .send({ outcome: 'opened', url: 'https://example.com/p/1' })
      .expect(200);

    expect(res.body.cards[0].type).toBe('affiliate_outcome');
    expect(res.body.cards[0].payload.outcome).toBe('opened');
  });
});

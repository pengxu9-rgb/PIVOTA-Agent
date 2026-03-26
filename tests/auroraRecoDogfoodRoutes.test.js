const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { mountRecoDogfoodRoutes } = require('../src/auroraBff/routes/recoDogfoodRoutes');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const deps = {
    logger: { warn: jest.fn(), info: jest.fn() },
    buildRequestContext: jest.fn(() => ({ request_id: 'req_reco_1' })),
    recoDogfoodConfig: {
      dogfood_mode: true,
      interleave: {
        rankerA: 'ranker_a',
        rankerB: 'ranker_b',
      },
    },
    RecoEmployeeFeedbackRequestSchema: z.object({
      anchor_product_id: z.string(),
      block: z.string(),
      candidate_product_id: z.string().optional(),
      candidate_name: z.string().optional(),
      feedback_type: z.string(),
      wrong_block_target: z.string().nullable().optional(),
      reason_tags: z.array(z.string()).optional(),
      was_exploration_slot: z.boolean().optional(),
      rank_position: z.number().optional(),
      pipeline_version: z.string().optional(),
      models: z.string().optional(),
      suggestion_id: z.string().nullable().optional(),
      llm_suggested_label: z.string().nullable().optional(),
      llm_confidence: z.number().nullable().optional(),
      request_id: z.string().optional(),
      session_id: z.string().optional(),
      timestamp: z.number().optional(),
    }),
    RecoInterleaveClickRequestSchema: z.object({
      anchor_product_id: z.string(),
      block: z.string(),
      candidate_product_id: z.string().optional(),
      candidate_name: z.string().optional(),
      request_id: z.string().optional(),
      session_id: z.string().optional(),
      category_bucket: z.string().optional(),
      price_band: z.string().optional(),
    }),
    RecoAsyncUpdatesRequestSchema: z.object({
      ticket_id: z.string(),
      since_version: z.any().optional(),
    }),
    getRecoDogfoodSessionId: jest.fn((_req, _ctx, explicit) => explicit || 'sess_reco_1'),
    pickFirstTrimmed: jest.fn((...values) => {
      for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
      }
      return '';
    }),
    getRecoTrackingMetadata: jest.fn(() => ({
      attribution: 'A',
      was_exploration_slot: true,
      rank_position: 2,
    })),
    writeRecoEmployeeFeedbackEvent: jest.fn((payload) => ({ ...payload })),
    setLlmSuggestionOverturnedRate: jest.fn(),
    recordRecoEmployeeFeedback: jest.fn(),
    recordRecoInterleaveClick: jest.fn(),
    recordRecoInterleaveWin: jest.fn(),
    getAsyncUpdates: jest.fn(() => ({
      ok: true,
      has_update: true,
      version: 2,
      payload_patch: {
        competitors: { candidates: [{ product_id: 'c1' }] },
        related_products: { candidates: [] },
        dupes: { candidates: [] },
      },
    })),
    recordRecoAsyncUpdate: jest.fn(),
  };

  mountRecoDogfoodRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountRecoDogfoodRoutes', () => {
  afterEach(() => {
    delete global.__auroraPrelabelFeedbackStats;
  });

  test('returns 404 for reco dogfood routes when dogfood mode is disabled', async () => {
    const { app } = buildApp({
      recoDogfoodConfig: { dogfood_mode: false, interleave: { rankerA: 'a', rankerB: 'b' } },
    });

    await request(app).post('/v1/reco/employee-feedback').send({}).expect(404);
    await request(app).post('/v1/reco/interleave/click').send({}).expect(404);
    await request(app).get('/v1/reco/async-updates').query({ ticket_id: 'ticket_1' }).expect(404);
  });

  test('records employee feedback and suggestion overturn rate through the dedicated owner', async () => {
    const { app, deps } = buildApp();

    const res = await request(app)
      .post('/v1/reco/employee-feedback')
      .send({
        anchor_product_id: 'anchor_1',
        block: 'competitors',
        candidate_product_id: 'cand_1',
        feedback_type: 'relevant',
        reason_tags: ['ingredient_mismatch'],
        llm_suggested_label: 'not_relevant',
        llm_confidence: 0.2,
        request_id: 'req_feedback_1',
        session_id: 'sess_feedback_1',
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.event.block).toBe('competitors');
    expect(deps.writeRecoEmployeeFeedbackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor_product_id: 'anchor_1',
        request_id: 'req_feedback_1',
        session_id: 'sess_feedback_1',
      }),
      expect.objectContaining({ logger: deps.logger }),
    );
    expect(deps.recordRecoEmployeeFeedback).toHaveBeenCalledWith({
      block: 'competitors',
      feedbackType: 'relevant',
      mode: 'main_path',
    });
    expect(deps.setLlmSuggestionOverturnedRate).toHaveBeenCalledWith(1);
  });

  test('records interleave click and async update metrics through the dedicated owner', async () => {
    const { app, deps } = buildApp();

    const clickRes = await request(app)
      .post('/v1/reco/interleave/click')
      .send({
        anchor_product_id: 'anchor_1',
        block: 'competitors',
        candidate_product_id: 'cand_1',
        request_id: 'req_click_1',
        session_id: 'sess_click_1',
        category_bucket: 'serum',
        price_band: 'mid',
      })
      .expect(200);

    expect(clickRes.body.ok).toBe(true);
    expect(clickRes.body.attribution).toBe('A');
    expect(deps.recordRecoInterleaveClick).toHaveBeenCalledWith({
      block: 'competitors',
      attribution: 'A',
      mode: 'main_path',
    });
    expect(deps.recordRecoInterleaveWin).toHaveBeenCalledWith({
      block: 'competitors',
      ranker: 'ranker_a',
      categoryBucket: 'serum',
      priceBand: 'mid',
      mode: 'main_path',
    });

    const asyncRes = await request(app)
      .get('/v1/reco/async-updates')
      .query({
        ticket_id: 'ticket_1',
        since_version: 1,
      })
      .expect(200);

    expect(asyncRes.body.ok).toBe(true);
    expect(deps.getAsyncUpdates).toHaveBeenCalledWith({
      ticketId: 'ticket_1',
      sinceVersion: 1,
    });
    expect(deps.recordRecoAsyncUpdate).toHaveBeenCalledTimes(3);
    expect(deps.recordRecoAsyncUpdate).toHaveBeenCalledWith({
      block: 'competitors',
      result: 'applied',
      mode: 'main_path',
      changedCount: 1,
    });
  });
});

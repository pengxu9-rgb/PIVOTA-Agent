const request = require('supertest');

describe('aurora reco dogfood feedback/interleave/async routes', () => {
  afterEach(() => {
    delete process.env.AURORA_BFF_RECO_DOGFOOD_MODE;
    delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    jest.resetModules();
  });

  test('dogfood disabled returns 404 for employee endpoints', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'false';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const app = require('../src/server');
    await request(app)
      .post('/v1/reco/employee-feedback')
      .send({})
      .expect(404);
    await request(app)
      .post('/v1/reco/interleave/click')
      .send({})
      .expect(404);
    await request(app)
      .get('/v1/reco/async-updates')
      .query({ ticket_id: 'x', since_version: 0 })
      .expect(404);
  });

  test('dogfood enabled accepts employee feedback payload', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const app = require('../src/server');
    const res = await request(app)
      .post('/v1/reco/employee-feedback')
      .set('X-Aurora-UID', 'uid_reco_feedback')
      .send({
        anchor_product_id: 'anchor_1',
        block: 'competitors',
        candidate_product_id: 'cand_1',
        feedback_type: 'relevant',
        reason_tags: ['ingredient_mismatch'],
        request_id: 'req_1',
        session_id: 'sess_1',
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.event).toBeTruthy();
    expect(res.body.event.block).toBe('competitors');
    expect(res.body.event.feedback_type).toBe('relevant');
    expect(res.body.event.request_id).toBe('req_1');
    expect(res.body.event.session_id).toBe('sess_1');
  });

  test('interleave click resolves attribution from tracking snapshot', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const app = require('../src/server');
    const { __internal } = require('../src/auroraBff/routes');
    __internal.registerRecoTrackingSnapshot({
      requestId: 'req_i1',
      sessionId: 'sess_i1',
      anchorProductId: 'anchor_i1',
      blocks: {
        competitors: [{ product_id: 'cand_i1' }],
        related_products: [],
        dupes: [],
      },
      trackingByBlock: {
        competitors: {
          cand_i1: {
            rank_position: 1,
            attribution: 'A',
            was_exploration_slot: true,
          },
        },
      },
      ttlMs: 60000,
    });

    const res = await request(app)
      .post('/v1/reco/interleave/click')
      .set('X-Aurora-UID', 'uid_reco_interleave')
      .send({
        anchor_product_id: 'anchor_i1',
        block: 'competitors',
        candidate_product_id: 'cand_i1',
        request_id: 'req_i1',
        session_id: 'sess_i1',
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.attribution).toBe('A');
    expect(res.body.was_exploration_slot).toBe(true);
    expect(res.body.rank_position).toBe(1);
  });

  test('async updates returns ticket patch when version advances', async () => {
    process.env.AURORA_BFF_RECO_DOGFOOD_MODE = 'true';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    const app = require('../src/server');
    const { __internal } = require('../src/auroraBff/routes');
    const ticket = __internal.createAsyncTicket({
      requestId: 'req_async_1',
      cardId: 'card_async_1',
      lockTopN: 2,
      initialPayload: {
        competitors: { candidates: [{ product_id: 'a1' }] },
        related_products: { candidates: [] },
        dupes: { candidates: [] },
        provenance: {},
      },
      ttlMs: 60000,
    });
    __internal.applyAsyncBlockPatch({
      ticketId: ticket.ticketId,
      block: 'competitors',
      nextCandidates: [{ product_id: 'a1', evidence_refs: [{ id: 'stub' }] }],
    });
    const res = await request(app)
      .get('/v1/reco/async-updates')
      .set('X-Aurora-UID', 'uid_reco_async')
      .query({
        ticket_id: ticket.ticketId,
        since_version: 1,
      })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.has_update).toBe(true);
    expect(Array.isArray(res.body.payload_patch?.competitors?.candidates)).toBe(true);
  });
});
